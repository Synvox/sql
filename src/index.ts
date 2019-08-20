import { PoolConfig, Pool, QueryResult, PoolClient } from 'pg';
import Debug from 'debug';
import { caseMethods, transformKeys, transformKey } from './case';

const debugQuery = Debug('sql:query');
const debugBinding = Debug('sql:binding');
const debugTransaction = Debug('sql:transaction');

const QueryBuilderSym = Symbol('is query builder');
const RawQuerySym = Symbol('is raw query');

type Primitive = string | number | boolean | null;

type Arg =
  | Primitive
  | Primitive[]
  | KeyValuePrimitive
  | QueryBuilderState
  | RawQuery
  | undefined;

interface QueryBuilderState {
  text: string;
  values: Primitive[];
}

interface QueryBuilder {
  [QueryBuilderSym]: boolean;
  text: string;
  values: Primitive[];
  exec: () => Promise<QueryResult>;
  maybeMany: () => Promise<unknown[]>;
  maybeOne: () => Promise<unknown>;
  many: () => Promise<unknown[]>;
  one: () => Promise<unknown>;
}

type RawQuery = {
  [RawQuerySym]: boolean;
  value: string;
};

type KeyValuePrimitive = {
  [id: string]: Primitive;
};

type Options = {
  caseMethod: 'snake' | 'camel' | 'constant' | 'pascal' | 'none';
  depth: number;
};

export function connect(
  config: PoolConfig,
  options: Options = {
    caseMethod: 'snake',
    depth: 0,
  }
) {
  return makeSql(new Pool(config), { ...options, depth: 0 });
}

function makeSql(
  client: Pool | PoolClient,
  options: Options = {
    caseMethod: 'snake',
    depth: 0,
  }
) {
  const caseMethodFromDb = caseMethods['camel'];
  const caseMethodToDb = caseMethods[options.caseMethod];

  function QueryBuilder(
    state: QueryBuilderState,
    queryClient: Pool | PoolClient = client
  ): QueryBuilder {
    // When another query is added to this one, the param numbers need
    // to be updated.
    const segments = state.text.split(/\$[0-9]/i);
    state.text = segments
      .map((segment, index) => {
        if (index + 1 === segments.length) return segment;
        return `${segment}$${index + 1}`;
      })
      .join('')
      .replace(/(\s)+/g, ' ');

    return Object.assign({}, state, {
      [QueryBuilderSym]: true,
      async exec() {
        state.text = state.text.trim();
        debugQuery(state.text);
        debugBinding(state.values);
        return await queryClient.query(state);
      },
      async maybeMany() {
        const result = await this.exec();
        return transformKeys(result.rows, caseMethodFromDb);
      },
      async maybeOne() {
        const rows = await this.maybeMany();
        const result = rows[0];
        return result;
      },
      async many() {
        const result = await this.maybeMany();
        if (result.length === 0)
          throw new Error('No rows returned from database ');
        return result;
      },
      async one() {
        const result = await this.many();
        return result[0];
      },
    });
  }

  function sql(strings: TemplateStringsArray, ...values: Arg[]): QueryBuilder {
    let state: QueryBuilderState = {
      text: '',
      values: [],
    };

    for (let index = 0; index < strings.length; index++) {
      const item = strings[index];
      state.text += item;

      // Handle last item
      if (!(index in values)) {
        continue;
      }

      const value = values[index];
      if (value === undefined) continue;

      // Handle primitive values
      if (typeof value !== 'object' || value === null) {
        state.values.push(value);
        state.text += `$0`;
        continue;
      }

      // Handle sub queries
      if (QueryBuilderSym in value) {
        const otherQuery = value as QueryBuilder;
        state.text += otherQuery.text;
        state.values.push(...otherQuery.values);
        continue;
      }

      // Handle arrays
      if (Array.isArray(value)) {
        const list = value as Primitive[];
        state.text += list.map(() => `$0`).join(', ');
        state.values.push(...list);
      }

      // Handle raw queries
      if (RawQuerySym in value) {
        const otherQuery = value as RawQuery;
        state.text += otherQuery.value;
        continue;
      }
    }

    return QueryBuilder(state);
  }

  function raw(str: string): RawQuery {
    return {
      [RawQuerySym]: true,
      value: str,
    };
  }

  function insertValues(object: KeyValuePrimitive) {
    return sql`(${raw(
      Object.keys(object)
        .map(key => transformKey(key, caseMethodToDb))
        .join(', ')
    )}) values (${Object.values(object)})`;
  }

  function setValues(object: KeyValuePrimitive) {
    const properties = Object.keys(object)
      .map(key => transformKey(key, caseMethodToDb))
      .map(key => `${key} = $0`)
      .join(`, `);

    return QueryBuilder({
      text: properties,
      values: Object.values(object).filter(item => item !== null),
    });
  }

  function cond(condition: boolean | any, statement: Arg) {
    if (condition) return statement;
    return undefined;
  }

  function where(
    object: KeyValuePrimitive,
    prefix: 'where' | 'and' | 'or' | '' = 'where',
    inverse: boolean = false,
    mode: 'and' | 'or' = 'and'
  ): QueryBuilder {
    const conditions = Object.keys(object)
      .map(key => {
        const transformedKey = transformKey(key, caseMethodToDb);
        const value = object[key];
        if (value === null)
          return `${transformedKey} is${inverse ? ' not ' : ''} null`;
        return `${transformedKey} ${inverse ? '<>' : '='} $0`;
      })
      .join(` ${mode} `);

    return QueryBuilder({
      text: `${prefix} (${conditions})`,
      values: Object.values(object).filter(item => item !== null),
    });
  }

  function whereNot(
    object: KeyValuePrimitive,
    prefix: 'where' | 'and' | 'or' = 'where',
    mode: 'and' | 'or' = 'and'
  ) {
    return where(object, prefix, true, mode);
  }

  function whereOr(
    object: KeyValuePrimitive,
    prefix: 'where' | 'and' | 'or' = 'where',
    inverse: boolean = false
  ) {
    return where(object, prefix, inverse, 'or');
  }

  function andWhere(object: KeyValuePrimitive, mode: 'and' | 'or' = 'and') {
    return where(object, 'and', false, mode);
  }

  function andWhereNot(object: KeyValuePrimitive, mode: 'and' | 'or' = 'and') {
    return where(object, 'and', true, mode);
  }

  function orWhere(object: KeyValuePrimitive, inverse: boolean = false) {
    return where(object, 'or', inverse);
  }

  function orWhereOr(object: KeyValuePrimitive, inverse: boolean = false) {
    return where(object, 'or', inverse, 'or');
  }

  let txId = 0;
  async function transaction(caller: (trxSql: Sql) => Promise<any>) {
    const isTopLevel = options.depth === 0;
    const trxClient = isTopLevel
      ? (((await client.connect()) as unknown) as PoolClient)
      : client;

    txId++;
    if (txId > Number.MAX_VALUE) txId = 0;

    const beginStmt = isTopLevel ? 'begin' : `savepoint tx${txId}`;

    const rollbackStmt = isTopLevel
      ? 'rollback'
      : `rollback to savepoint tx${txId}`;

    debugTransaction(beginStmt, `(tx${txId})`);
    trxClient.query(beginStmt);
    const sql = makeSql(trxClient, { ...options, depth: options.depth + 1 });

    try {
      const result = await caller(sql);

      if (isTopLevel) {
        debugTransaction('commit', `(tx${txId})`);
        await trxClient.query('commit');
      }

      return result;
    } catch (e) {
      debugTransaction(rollbackStmt, `(tx${txId})`);
      trxClient.query(rollbackStmt);
      throw e;
    } finally {
      if (isTopLevel) await (trxClient as PoolClient).release();
    }
  }

  const boundSql = Object.assign(sql, {
    where,
    raw,
    insertValues,
    setValues,
    cond,
    whereNot,
    whereOr,
    andWhere,
    andWhereNot,
    orWhere,
    orWhereOr,
    transaction,
  });

  type Sql = typeof boundSql;

  return Object.freeze(boundSql);
}
