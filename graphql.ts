// The GraphQL v4 surface at /api/graphql: a small parser and executor for the documents gh
// and github-mcp-server send — queries with variables, aliases, fragments and batched
// operations, the repository/issue/pull-request fields they read, the mutations they make,
// and the introspection (__type/__schema) their clients use to discover all of it. Failures
// at the GraphQL level answer HTTP 200 with an errors array, GitHub-style; a request with no
// bearer token answers 401 before any of this runs.

import { globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { parseCommit } from './gitobj.ts';
import { commitTreeOid, diffTrees, mergeBase, refCommit, threeWayMergeTrees } from './graph.ts';
import { mergePullRecord } from './rest.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  directives: Record<string, Record<string, Value>>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string; directives: Record<string, Record<string, Value>> };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, Value>;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class GqlSyntax extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntax('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntax('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i)) as RegExpExecArray;
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new GqlSyntax(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;
  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos] as { kind: string; value: string };
  }
  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos] as { kind: string; value: string };
    this.pos += 1;
    return token;
  }
  private expect(kind: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind) throw new GqlSyntax(`expected ${kind}, saw ${token.kind} ${token.value}`);
    return token;
  }
  private skip(kind: string): boolean {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({
          type: 'query',
          name: null,
          variableDefaults: {},
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const name = this.peek().kind === 'name' ? this.next().value : null;
        const variableDefaults = this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({
          type: token.value as 'query' | 'mutation',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name'); // 'on'
        const condition = this.expect('name').value;
        this.parseDirectives();
        fragments.set(fragName, { typeCondition: condition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new GqlSyntax(`unexpected token ${token.kind} ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Record<string, Value> {
    const defaults: Record<string, Value> = {};
    if (!this.skip('(')) return defaults;
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      this.parseType();
      if (this.skip('=')) defaults[name] = this.parseValue(true);
      this.parseDirectives();
    }
    this.expect(')');
    return defaults;
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private parseDirectives(): Record<string, Record<string, Value>> {
    const directives: Record<string, Record<string, Value>> = {};
    while (this.skip('@')) {
      const name = this.expect('name').value;
      directives[name] = this.parseArgs();
    }
    return directives;
  }

  private parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (!this.skip('(')) return args;
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }

  private parseValue(constant: boolean): Value {
    const token = this.next();
    if (token.kind === '$') {
      if (constant) throw new GqlSyntax('variable in constant value');
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === '[') {
      const values: Value[] = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(constant));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue(constant);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new GqlSyntax(`unexpected value token ${token.kind}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const condition = this.expect('name').value;
        this.parseDirectives();
        return { kind: 'inline', typeCondition: condition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    const first = this.expect('name').value;
    let alias: string | null = null;
    let name = first;
    if (this.skip(':')) {
      alias = first;
      name = this.expect('name').value;
    }
    const args = this.parseArgs();
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// ---------------------------------------------------------------- values

type Vars = Record<string, unknown>;

function resolveValue(value: Value, vars: Vars): unknown {
  switch (value.kind) {
    case 'variable':
      return vars[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, vars);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, Value>, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const resolved = resolveValue(value, vars);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function directiveSkips(directives: Record<string, Record<string, Value>>, vars: Vars): boolean {
  for (const [name, args] of Object.entries(directives)) {
    const condition = args.if !== undefined ? resolveValue(args.if, vars) : undefined;
    if (name === 'skip' && condition === true) return true;
    if (name === 'include' && condition === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------- schema metadata

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'label', 'labels', 'createdAt', 'updatedAt', 'url', 'isFork', 'isArchived', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'labels', 'author', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'author', 'repository', 'additions', 'deletions',
    'changedFiles', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Organization: ['id', 'databaseId', 'login', 'name', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'tree'],
  Tree: ['id', 'oid'],
  GitActor: ['name', 'email', 'date', 'user'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount', 'wikiCount'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'nodeCount', 'used'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  ReopenIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_TYPES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueClosedStateReason: ['COMPLETED', 'NOT_PLANNED'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const INPUT_TYPES: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'labelIds', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
  ReopenIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

const CONCRETE_TYPES = new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES)]);

function typeObject(name: string): Record<string, unknown> | null {
  if (Object.hasOwn(TYPE_FIELDS, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      fields: (TYPE_FIELDS[name] as string[]).map((field) => ({
        __typename: '__Field',
        name: field,
        description: null,
        args: [],
        type: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      enumValues: null,
      possibleTypes: null,
      inputFields: null,
      ofType: null,
    };
  }
  if (Object.hasOwn(ENUM_TYPES, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: (ENUM_TYPES[name] as string[]).map((value) => ({
        __typename: '__EnumValue',
        name: value,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      possibleTypes: null,
      inputFields: null,
      ofType: null,
    };
  }
  if (Object.hasOwn(INPUT_TYPES, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'INPUT_OBJECT',
      description: null,
      fields: null,
      enumValues: null,
      possibleTypes: null,
      inputFields: (INPUT_TYPES[name] as string[]).map((field) => ({
        __typename: '__InputValue',
        name: field,
        description: null,
        type: null,
        defaultValue: null,
      })),
      ofType: null,
    };
  }
  if (name === 'String' || name === 'Int' || name === 'Float' || name === 'Boolean' || name === 'ID' || name === 'DateTime' || name === 'URI' || name === 'GitObjectID') {
    return { __typename: '__Type', name, kind: 'SCALAR', description: null, fields: null, enumValues: null, possibleTypes: null, inputFields: null, ofType: null };
  }
  return null;
}

function schemaObject(): Record<string, unknown> {
  const names = [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES), ...Object.keys(INPUT_TYPES)];
  return {
    __typename: '__Schema',
    types: names.map((name) => typeObject(name)),
    queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
    mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
    subscriptionType: null,
    directives: [],
  };
}

// ---------------------------------------------------------------- domain objects

type GqlObj = Record<string, unknown> & { __typename: string };

function userObj(store: Store, login?: string): GqlObj {
  const viewer = store.viewer;
  const isViewer = login === undefined || login === viewer.login;
  return {
    __typename: 'User',
    _login: isViewer ? viewer.login : (login as string),
    _id: isViewer ? viewer.id : 0,
    _name: isViewer ? viewer.name : '',
    _email: isViewer ? viewer.email : '',
  };
}

function repoObj(repo: RepoRec): GqlObj {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function cursorOf(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function cursorKey(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface ConnectionSpec {
  type: string;
  edgeType: string;
}

/** Slice an ordered node list into a connection under first/after. */
function connection(spec: ConnectionSpec, nodes: GqlObj[], keys: number[], args: Record<string, unknown>): GqlObj {
  let start = 0;
  const afterKey = cursorKey(args.after);
  if (afterKey !== null) {
    const index = keys.indexOf(afterKey);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : nodes.length;
  const slice = nodes.slice(start, start + first);
  const sliceKeys = keys.slice(start, start + first);
  const edges = slice.map((node, i) => ({
    __typename: spec.edgeType,
    node,
    cursor: cursorOf(sliceKeys[i] as number),
  }));
  return {
    __typename: spec.type,
    nodes: slice,
    edges,
    totalCount: nodes.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as GqlObj).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as GqlObj).cursor : null,
    },
  };
}

function repoOf(obj: GqlObj): RepoRec {
  return obj._repo as RepoRec;
}

function pullFiles(store: Store, repo: RepoRec, pull: PullRec): Array<{ path: string; additions: number; deletions: number; changeType: string }> {
  const headCommit = refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseCommit = refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, baseCommit, headCommit);
  const diffs = diffTrees(
    repo,
    base === null ? null : commitTreeOid(repo, base),
    commitTreeOid(repo, headCommit),
  );
  void store;
  return diffs.map((diff) => ({
    path: diff.filename,
    additions: diff.additions,
    deletions: diff.deletions,
    changeType: diff.status === 'added' ? 'ADDED' : diff.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
}

function pullMergeable(repo: RepoRec, pull: PullRec): string {
  const headCommit = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseCommit = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headCommit === null || baseCommit === null) return 'UNKNOWN';
  const base = mergeBase(repo, baseCommit, headCommit);
  const outcome = threeWayMergeTrees(
    repo,
    base === null ? null : commitTreeOid(repo, base),
    commitTreeOid(repo, baseCommit),
    commitTreeOid(repo, headCommit),
  );
  return outcome.tree === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- node lookup

function repoById(store: Store, id: number): RepoRec | undefined {
  return store.viewerRepos().find((repo) => repo.id === id);
}

function nodeById(store: Store, id: string): GqlObj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const [first, second] = parsed.parts;
  if (parsed.type === 'Repository') {
    const repo = repoById(store, Number(first));
    return repo === undefined ? null : repoObj(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const repo = repoById(store, Number(first));
    if (repo === undefined) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(Number(second));
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(Number(second));
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (parsed.type === 'User') {
    return Number(first) === store.viewer.id ? userObj(store) : null;
  }
  if (parsed.type === 'IssueComment') {
    const commentId = Number(first);
    for (const repo of store.viewerRepos()) {
      for (const host of [...repo.issues.values(), ...repo.pulls.values()]) {
        const comment = host.comments.find((candidate) => candidate.id === commentId);
        if (comment !== undefined) {
          return {
            __typename: 'IssueComment',
            _comment: comment,
            _repo: repo,
          };
        }
      }
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- resolvers

interface Ctx {
  store: Store;
  vars: Vars;
  errors: Array<{ message: string }>;
  fragments: Document['fragments'];
}

type Resolver = (ctx: Ctx, obj: GqlObj, args: Record<string, unknown>) => unknown;

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : args;
}

function findIssue(store: Store, id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const repo = repoById(store, Number(parsed.parts[0]));
  const issue = repo?.issues.get(Number(parsed.parts[1]));
  return repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function findPull(store: Store, id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const repo = repoById(store, Number(parsed.parts[0]));
  const pull = repo?.pulls.get(Number(parsed.parts[1]));
  return repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userObj(ctx.store),
    repository: (ctx, _obj, args) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObj(repo);
    },
    node: (ctx, _obj, args) => (typeof args.id === 'string' ? nodeById(ctx.store, args.id) : null),
    nodes: (ctx, _obj, args) =>
      Array.isArray(args.ids) ? args.ids.map((id) => (typeof id === 'string' ? nodeById(ctx.store, id) : null)) : [],
    search: () => ({
      __typename: 'SearchResultItemConnection',
      nodes: [],
      edges: [],
      totalCount: 0,
      issueCount: 0,
      repositoryCount: 0,
      userCount: 0,
      wikiCount: 0,
      pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
    user: (ctx, _obj, args) => (args.login === ctx.store.viewer.login ? userObj(ctx.store) : null),
    organization: () => null,
    rateLimit: () => ({
      __typename: 'RateLimit',
      limit: 5000,
      cost: 1,
      remaining: 4999,
      used: 1,
      nodeCount: 0,
      resetAt: new Date((1735689600 + 3600) * 1000).toISOString(),
    }),
  },
  Mutation: {
    createIssue: (ctx, _obj, args) => {
      const input = inputOf(args);
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoById(ctx.store, Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new Error('title is required');
      const stamp = ctx.store.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        tick: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return {
        __typename: 'CreateIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: issueObj(repo, issue),
      };
    },
    closeIssue: (ctx, _obj, args) => {
      const input = inputOf(args);
      const found = findIssue(ctx.store, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.store.nowIso();
      return {
        __typename: 'CloseIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: issueObj(found.repo, found.issue),
      };
    },
    reopenIssue: (ctx, _obj, args) => {
      const input = inputOf(args);
      const found = findIssue(ctx.store, input.issueId);
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'open';
      found.issue.updatedAt = ctx.store.nowIso();
      return {
        __typename: 'ReopenIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: issueObj(found.repo, found.issue),
      };
    },
    createPullRequest: (ctx, _obj, args) => {
      const input = inputOf(args);
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoById(ctx.store, Number(parsed.parts[0])) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        throw new Error('head or base branch does not exist');
      }
      const stamp = ctx.store.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        tick: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return {
        __typename: 'CreatePullRequestPayload',
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: pullObj(repo, pull),
      };
    },
    mergePullRequest: (ctx, _obj, args) => {
      const input = inputOf(args);
      const found = findPull(ctx.store, input.pullRequestId);
      if (found === null) throw new Error('pull request not found');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const result = mergePullRecord(ctx.store, found.repo, found.pull, method);
      if ('error' in result) throw new Error(result.message);
      return {
        __typename: 'MergePullRequestPayload',
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: pullObj(found.repo, found.pull),
      };
    },
    addComment: (ctx, _obj, args) => {
      const input = inputOf(args);
      const body = typeof input.body === 'string' ? input.body : '';
      if (body === '') throw new Error('body is required');
      const subject = typeof input.subjectId === 'string' ? nodeById(ctx.store, input.subjectId) : null;
      if (subject === null || (subject.__typename !== 'Issue' && subject.__typename !== 'PullRequest')) {
        throw new Error('subject not found');
      }
      const repo = repoOf(subject);
      const host = (subject.__typename === 'Issue' ? subject._issue : subject._pull) as IssueRec | PullRec;
      const stamp = ctx.store.nowIso();
      const comment = { id: ctx.store.nextCommentId(), body, createdAt: stamp, updatedAt: stamp };
      host.comments.push(comment);
      const commentObject: GqlObj = { __typename: 'IssueComment', _comment: comment, _repo: repo };
      return {
        __typename: 'AddCommentPayload',
        clientMutationId: input.clientMutationId ?? null,
        commentEdge: { __typename: 'IssueCommentEdge', node: commentObject, cursor: cursorOf(comment.id) },
        subject,
      };
    },
  },
  Repository: {
    id: (_ctx, obj) => globalId('Repository', repoOf(obj).id),
    databaseId: (_ctx, obj) => repoOf(obj).id,
    name: (_ctx, obj) => repoOf(obj).name,
    nameWithOwner: (_ctx, obj) => `${repoOf(obj).owner}/${repoOf(obj).name}`,
    owner: (ctx, obj) => userObj(ctx.store, repoOf(obj).owner),
    description: (_ctx, obj) => repoOf(obj).description,
    isPrivate: (_ctx, obj) => repoOf(obj).isPrivate,
    defaultBranchRef: (_ctx, obj) => {
      const repo = repoOf(obj);
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return oid === undefined
        ? null
        : { __typename: 'Ref', _name: repo.defaultBranch, _prefix: 'refs/heads/', _oid: oid, _repo: repo };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => false,
    isFork: () => false,
    isArchived: () => false,
    stargazerCount: () => 0,
    forkCount: () => 0,
    createdAt: (_ctx, obj) => repoOf(obj).createdAt,
    updatedAt: (_ctx, obj) => repoOf(obj).updatedAt,
    url: (_ctx, obj) => `https://forge.local/${repoOf(obj).owner}/${repoOf(obj).name}`,
    issue: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection(
        { type: 'IssueConnection', edgeType: 'IssueEdge' },
        issues.map((issue) => issueObj(repo, issue)),
        issues.map((issue) => issue.number),
        args,
      );
    },
    pullRequest: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
    pullRequests: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
      pulls = pulls.filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(state);
      });
      pulls.sort((a, b) => b.number - a.number);
      return connection(
        { type: 'PullRequestConnection', edgeType: 'PullRequestEdge' },
        pulls.map((pull) => pullObj(repo, pull)),
        pulls.map((pull) => pull.number),
        args,
      );
    },
    label: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const name = String(args.name ?? '');
      return repo.labels.has(name) ? { __typename: 'Label', _repo: repo, _name: name } : null;
    },
    labels: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const names = [...repo.labels.keys()].sort();
      return connection(
        { type: 'LabelConnection', edgeType: 'LabelEdge' },
        names.map((name) => ({ __typename: 'Label', _repo: repo, _name: name }) as GqlObj),
        names.map((_, index) => index + 1),
        args,
      );
    },
  },
  Issue: {
    id: (_ctx, obj) => globalId('Issue', repoOf(obj).id, (obj._issue as IssueRec).number),
    databaseId: (_ctx, obj) => repoOf(obj).id * 1000000 + (obj._issue as IssueRec).number,
    number: (_ctx, obj) => (obj._issue as IssueRec).number,
    title: (_ctx, obj) => (obj._issue as IssueRec).title,
    body: (_ctx, obj) => (obj._issue as IssueRec).body,
    state: (_ctx, obj) => ((obj._issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: (ctx) => userObj(ctx.store),
    repository: (_ctx, obj) => repoObj(repoOf(obj)),
    createdAt: (_ctx, obj) => (obj._issue as IssueRec).createdAt,
    updatedAt: (_ctx, obj) => (obj._issue as IssueRec).updatedAt,
    closedAt: (_ctx, obj) => {
      const issue = obj._issue as IssueRec;
      return issue.state === 'closed' ? issue.updatedAt : null;
    },
    url: (_ctx, obj) => `https://forge.local/${repoOf(obj).owner}/${repoOf(obj).name}/issues/${(obj._issue as IssueRec).number}`,
    labels: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const issue = obj._issue as IssueRec;
      return connection(
        { type: 'LabelConnection', edgeType: 'LabelEdge' },
        issue.labels.map((name) => ({ __typename: 'Label', _repo: repo, _name: name }) as GqlObj),
        issue.labels.map((_, index) => index + 1),
        args,
      );
    },
    comments: (_ctx, obj, args) => {
      const repo = repoOf(obj);
      const issue = obj._issue as IssueRec;
      return connection(
        { type: 'IssueCommentConnection', edgeType: 'IssueCommentEdge' },
        issue.comments.map((comment) => ({ __typename: 'IssueComment', _comment: comment, _repo: repo }) as GqlObj),
        issue.comments.map((comment) => comment.id),
        args,
      );
    },
  },
  PullRequest: {
    id: (_ctx, obj) => globalId('PullRequest', repoOf(obj).id, (obj._pull as PullRec).number),
    databaseId: (_ctx, obj) => repoOf(obj).id * 1000000 + (obj._pull as PullRec).number,
    number: (_ctx, obj) => (obj._pull as PullRec).number,
    title: (_ctx, obj) => (obj._pull as PullRec).title,
    body: (_ctx, obj) => (obj._pull as PullRec).body,
    state: (_ctx, obj) => {
      const pull = obj._pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ctx, obj) => (obj._pull as PullRec).merged,
    mergeable: (_ctx, obj) => pullMergeable(repoOf(obj), obj._pull as PullRec),
    headRefName: (_ctx, obj) => (obj._pull as PullRec).headRef,
    baseRefName: (_ctx, obj) => (obj._pull as PullRec).baseRef,
    headRef: (_ctx, obj) => refObject(repoOf(obj), (obj._pull as PullRec).headRef),
    baseRef: (_ctx, obj) => refObject(repoOf(obj), (obj._pull as PullRec).baseRef),
    author: (ctx) => userObj(ctx.store),
    repository: (_ctx, obj) => repoObj(repoOf(obj)),
    createdAt: (_ctx, obj) => (obj._pull as PullRec).createdAt,
    updatedAt: (_ctx, obj) => (obj._pull as PullRec).updatedAt,
    closedAt: (_ctx, obj) => {
      const pull = obj._pull as PullRec;
      return pull.state === 'closed' || pull.merged ? pull.updatedAt : null;
    },
    mergedAt: (_ctx, obj) => (obj._pull as PullRec).mergedAt,
    mergeCommit: (_ctx, obj) => {
      const pull = obj._pull as PullRec;
      return pull.mergeCommitSha === null
        ? null
        : { __typename: 'Commit', _oid: pull.mergeCommitSha, _repo: repoOf(obj) };
    },
    url: (_ctx, obj) => `https://forge.local/${repoOf(obj).owner}/${repoOf(obj).name}/pull/${(obj._pull as PullRec).number}`,
    files: (ctx, obj, args) => {
      const repo = repoOf(obj);
      const files = pullFiles(ctx.store, repo, obj._pull as PullRec);
      return connection(
        { type: 'PullRequestChangedFileConnection', edgeType: 'PullRequestChangedFileEdge' },
        files.map((file) => ({ __typename: 'PullRequestChangedFile', ...file }) as GqlObj),
        files.map((_, index) => index + 1),
        args,
      );
    },
    additions: (ctx, obj) => pullFiles(ctx.store, repoOf(obj), obj._pull as PullRec).reduce((sum, file) => sum + file.additions, 0),
    deletions: (ctx, obj) => pullFiles(ctx.store, repoOf(obj), obj._pull as PullRec).reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (ctx, obj) => pullFiles(ctx.store, repoOf(obj), obj._pull as PullRec).length,
  },
  User: {
    id: (_ctx, obj) => globalId('User', obj._id as number),
    databaseId: (_ctx, obj) => obj._id as number,
    login: (_ctx, obj) => obj._login as string,
    name: (_ctx, obj) => obj._name as string,
    email: (_ctx, obj) => obj._email as string,
    url: (_ctx, obj) => `https://forge.local/${obj._login as string}`,
  },
  Label: {
    id: (_ctx, obj) => globalId('Label', repoOf(obj).id, obj._name as string),
    name: (_ctx, obj) => obj._name as string,
    color: (_ctx, obj) => repoOf(obj).labels.get(obj._name as string)?.color ?? 'ededed',
    description: (_ctx, obj) => repoOf(obj).labels.get(obj._name as string)?.description ?? null,
  },
  IssueComment: {
    id: (_ctx, obj) => globalId('IssueComment', (obj._comment as { id: number }).id),
    databaseId: (_ctx, obj) => (obj._comment as { id: number }).id,
    body: (_ctx, obj) => (obj._comment as { body: string }).body,
    author: (ctx) => userObj(ctx.store),
    createdAt: (_ctx, obj) => (obj._comment as { createdAt: string }).createdAt,
    updatedAt: (_ctx, obj) => (obj._comment as { updatedAt: string }).updatedAt,
  },
  Ref: {
    id: (_ctx, obj) => globalId('Ref', `${obj._prefix as string}${obj._name as string}`),
    name: (_ctx, obj) => obj._name as string,
    prefix: (_ctx, obj) => obj._prefix as string,
    target: (_ctx, obj) => ({ __typename: 'Commit', _oid: obj._oid as string, _repo: obj._repo as RepoRec }),
  },
  Commit: {
    id: (_ctx, obj) => globalId('Commit', obj._oid as string),
    oid: (_ctx, obj) => obj._oid as string,
    message: (_ctx, obj) => commitText(obj).message.replace(/\n$/, ''),
    messageHeadline: (_ctx, obj) => commitText(obj).message.split('\n')[0] ?? '',
    committedDate: (_ctx, obj) => new Date(commitSeconds(obj) * 1000).toISOString(),
    author: (_ctx, obj) => {
      const commit = commitText(obj);
      const match = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(commit.author);
      return {
        __typename: 'GitActor',
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date(commitSeconds(obj) * 1000).toISOString(),
        user: null,
      };
    },
    tree: (_ctx, obj) => ({ __typename: 'Tree', _oid: commitText(obj).tree }),
  },
  Tree: {
    id: (_ctx, obj) => globalId('Tree', obj._oid as string),
    oid: (_ctx, obj) => obj._oid as string,
  },
};

function refObject(repo: RepoRec, branch: string): GqlObj | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined
    ? null
    : ({ __typename: 'Ref', _name: branch, _prefix: 'refs/heads/', _oid: oid, _repo: repo } as GqlObj);
}

function commitText(obj: GqlObj): { tree: string; author: string; message: string } {
  const repo = obj._repo as RepoRec;
  const object = repo.objects.get(obj._oid as string);
  if (object === undefined || object.type !== 'commit') return { tree: '', author: '', message: '' };
  const commit = parseCommit(object.data);
  return { tree: commit.tree, author: commit.author, message: commit.message };
}

function commitSeconds(obj: GqlObj): number {
  const repo = obj._repo as RepoRec;
  const object = repo.objects.get(obj._oid as string);
  if (object === undefined || object.type !== 'commit') return 1735689600;
  const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(object.data).committer);
  return match ? Number(match[1]) : 1735689600;
}

// ---------------------------------------------------------------- execution

function isObject(value: unknown): value is GqlObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function conditionMatches(condition: string | null, typeName: string): boolean {
  if (condition === null || condition === typeName) return true;
  return !CONCRETE_TYPES.has(condition); // an interface name applies leniently
}

function executeField(ctx: Ctx, typeName: string, obj: GqlObj, field: FieldNode): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  const args = resolveArgs(field.args, ctx.vars);
  let value: unknown;
  if (name === '__type' && typeName === 'Query') {
    value = typeof args.name === 'string' ? typeObject(args.name) : null;
  } else if (name === '__schema' && typeName === 'Query') {
    value = schemaObject();
  } else {
    const resolver = RESOLVERS[typeName]?.[name];
    if (resolver !== undefined) {
      try {
        value = resolver(ctx, obj, args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'internal error' });
        value = null;
      }
    } else if (isObject(obj) && name in obj) {
      value = obj[name];
    } else if ((TYPE_FIELDS[typeName] ?? []).includes(name)) {
      value = null; // a declared field this forge leaves empty
    } else {
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
      value = null;
    }
  }
  if (field.selectionSet === null || value === null || value === undefined) {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      isObject(item)
        ? executeSelectionSet(ctx, (item.__typename as string) ?? typeName, item, field.selectionSet as SelectionNode[])
        : item,
    );
  }
  if (isObject(value)) {
    return executeSelectionSet(ctx, (value.__typename as string) ?? typeName, value, field.selectionSet);
  }
  return value;
}

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  obj: GqlObj,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const assign = (key: string, value: unknown): void => {
    const existing = out[key];
    if (isObject(existing) && isObject(value) && !('__typename' in value && value.__typename === '__Type')) {
      out[key] = { ...existing, ...value };
    } else {
      out[key] = value;
    }
  };
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (directiveSkips(selection.directives, ctx.vars)) continue;
      assign(selection.alias ?? selection.name, executeField(ctx, typeName, obj, selection));
    } else if (selection.kind === 'inline') {
      if (!conditionMatches(selection.typeCondition, typeName)) continue;
      const inner = executeSelectionSet(ctx, typeName, obj, selection.selectionSet);
      for (const [key, value] of Object.entries(inner)) assign(key, value);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (directiveSkips(selection.directives, ctx.vars)) continue;
      if (!conditionMatches(fragment.typeCondition, typeName)) continue;
      const inner = executeSelectionSet(ctx, typeName, obj, fragment.selectionSet);
      for (const [key, value] of Object.entries(inner)) assign(key, value);
    }
  }
  return out;
}

function executeOperation(store: Store, doc: Document, operation: Operation, variables: Vars): Record<string, unknown> {
  const vars: Vars = {};
  for (const [name, defaultValue] of Object.entries(operation.variableDefaults)) {
    vars[name] = resolveValue(defaultValue, {});
  }
  Object.assign(vars, variables);
  const ctx: Ctx = { store, vars, errors: [], fragments: doc.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, { __typename: rootType }, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

function executeOne(store: Store, item: unknown): Record<string, unknown> {
  if (!isObject(item) || typeof item.query !== 'string') {
    return { errors: [{ message: 'a GraphQL document is required' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(tokenize(item.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operationName = typeof item.operationName === 'string' ? item.operationName : null;
  const operation =
    operationName !== null
      ? doc.operations.find((candidate) => candidate.name === operationName)
      : doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation to execute' }] };
  const variables = isObject(item.variables) ? (item.variables as Vars) : {};
  return executeOperation(store, doc, operation, variables);
}

/** POST /api/graphql: one operation document, or a batch of them answered in order. */
export function handleGraphql(store: Store, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 200, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((item) => executeOne(store, item)) };
  }
  return { status: 200, body: executeOne(store, parsed) };
}
