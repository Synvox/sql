import { connect } from '../src';

const sql = connect({});

describe('substitutions', () => {
  it('supports basic substitution', () => {
    expect(sql`select * from users where id=${1}`).toMatchObject({
      text: 'select * from users where id=$1',
      values: [1],
    });
  });

  it('supports subqueries', () => {
    expect(
      sql`select * from users where id in (${sql`select id from comments where id=${1}`})`
    ).toMatchObject({
      text:
        'select * from users where id in (select id from comments where id=$1)',
      values: [1],
    });
  });

  it('reorders params when a subquery is introduced', () => {
    expect(
      sql`select * from users where deleted_at=${false} and id in (${sql`select id from comments where id=${1}`})`
    ).toMatchObject({
      text:
        'select * from users where deleted_at=$1 and id in (select id from comments where id=$2)',
      values: [false, 1],
    });
  });

  it('supports raw substitutions', () => {
    expect(sql`select ${sql.raw('column')} from users`).toMatchObject({
      text: 'select column from users',
      values: [],
    });
  });

  it('supports arrays', () => {
    expect(sql`select * from users where id in (${[1, 2, 3]})`).toMatchObject({
      text: 'select * from users where id in ($1, $2, $3)',
      values: [1, 2, 3],
    });
  });

  it('supports conditional substitution', () => {
    expect(
      sql`select * from users ${sql.cond(false, sql`deleted_at is null`)}`
    ).toMatchObject({
      text: 'select * from users ',
      values: [],
    });

    expect(
      sql`select * from users ${sql.cond(true, sql`where deleted_at is null`)}`
    ).toMatchObject({
      text: 'select * from users where deleted_at is null',
      values: [],
    });
  });

  it('supports insertValues helper', () => {
    expect(
      sql`insert into users ${sql.insertValues({
        name: 'Ryan',
        number: 0,
      })}`
    ).toMatchObject({
      text: 'insert into users (name, number) values ($1, $2)',
      values: ['Ryan', 0],
    });
  });

  it('supports setValues helper', () => {
    expect(
      sql`update users set ${sql.setValues({
        name: 'Ryan',
        active: true,
      })}`
    ).toMatchObject({
      text: 'update users set name = $1, active = $2',
      values: ['Ryan', true],
    });
  });

  it('supports setValues helper', () => {
    expect(
      sql`update users set ${sql.setValues({
        name: 'Ryan',
        active: true,
      })}`
    ).toMatchObject({
      text: 'update users set name = $1, active = $2',
      values: ['Ryan', true],
    });
  });

  it('supports where helper', () => {
    expect(
      sql`select * from table_name ${sql.where({ val: 1, val2: false })}`
    ).toMatchObject({
      text: 'select * from table_name where (val = $1 and val2 = $2)',
      values: [1, false],
    });
  });

  it('supports whereNot helper', () => {
    expect(
      sql`select * from table_name ${sql.whereNot({ val: 1, val2: null })}`
    ).toMatchObject({
      text: 'select * from table_name where (val <> $1 and val2 is not null)',
      values: [1],
    });
  });

  it('supports whereOr helper', () => {
    expect(
      sql`select * from table_name ${sql.whereOr({ val: 1, val2: null })}`
    ).toMatchObject({
      text: 'select * from table_name where (val = $1 or val2 is null)',
      values: [1],
    });
  });

  it('supports orWhere helper', () => {
    expect(
      sql`select * from table_name ${sql.where({ bool: false })} ${sql.orWhere({
        val: 1,
        val2: null,
      })}`
    ).toMatchObject({
      text:
        'select * from table_name where (bool = $1) or (val = $2 and val2 is null)',
      values: [false, 1],
    });
  });

  it('supports andWhere helper', () => {
    expect(
      sql`select * from table_name ${sql.where({ bool: false })} ${sql.andWhere(
        {
          val: 1,
          val2: null,
        }
      )}`
    ).toMatchObject({
      text:
        'select * from table_name where (bool = $1) and (val = $2 and val2 is null)',
      values: [false, 1],
    });
  });

  it('supports andWhereNot helper', () => {
    expect(
      sql`select * from table_name ${sql.where({
        bool: false,
      })} ${sql.andWhereNot({
        val: 1,
        val2: null,
      })}`
    ).toMatchObject({
      text:
        'select * from table_name where (bool = $1) and (val <> $2 and val2 is not null)',
      values: [false, 1],
    });
  });

  it('supports orWhereOr helper', () => {
    expect(
      sql`select * from table_name ${sql.where({
        bool: false,
      })} ${sql.orWhereOr({
        val: 1,
        val2: null,
      })}`
    ).toMatchObject({
      text:
        'select * from table_name where (bool = $1) or (val = $2 or val2 is null)',
      values: [false, 1],
    });
  });
});

describe('speaks postgres', () => {
  beforeEach(async () => {
    await sql`
      create schema test;
    `.exec();
  });

  afterEach(async () => {
    await sql`
      drop schema test cascade;
    `.exec();
  });

  afterAll(async () => {
    await sql.end();
  });

  it('inserts and queries', async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.insertValues({
        firstName: 'Ryan',
        lastName: 'Allred',
      })}
    `.exec();

    const result = await sql`select * from test.users`.many();

    expect(result).toEqual([{ id: 1, firstName: 'Ryan', lastName: 'Allred' }]);
  });

  describe('transactions', () => {
    it('supports commit', async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      try {
        await sql.transaction(async sql => {
          await sql`
            insert into test.users ${sql.insertValues({
              firstName: 'Ryan',
              lastName: 'Allred',
            })}
          `.exec();

          const result = await sql`select * from test.users`.many();

          expect(result).toEqual([
            { id: 1, firstName: 'Ryan', lastName: 'Allred' },
          ]);
        });
      } catch (e) {}

      const result = await sql`select * from test.users`.maybeMany();

      expect(result).toEqual([
        { id: 1, firstName: 'Ryan', lastName: 'Allred' },
      ]);
    });

    it('supports rollback', async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      try {
        await sql.transaction(async sql => {
          await sql`
            insert into test.users ${sql.insertValues({
              firstName: 'Ryan',
              lastName: 'Allred',
            })}
          `.exec();

          const result = await sql`select * from test.users`.many();

          expect(result).toEqual([
            { id: 1, firstName: 'Ryan', lastName: 'Allred' },
          ]);

          throw new Error('rollback');
        });
      } catch (e) {}

      const result = await sql`select * from test.users`.maybeMany();

      expect(result).toEqual([]);
    });

    it('supports savepoints', async () => {
      await sql`
        create table test.users (
          id serial primary key,
          first_name text not null,
          last_name text not null
        );
      `.exec();

      await sql.transaction(async sql => {
        await sql`
          insert into test.users ${sql.insertValues({
            firstName: 'Ryan',
            lastName: 'Allred',
          })}
        `.exec();

        try {
          await sql.transaction(async sql => {
            await sql`
              insert into test.users ${sql.insertValues({
                firstName: 'Ryan',
                lastName: 'Allred',
              })}
            `.exec();

            const result = await sql`select * from test.users`.many();

            expect(result).toEqual([
              { id: 1, firstName: 'Ryan', lastName: 'Allred' },
              { id: 2, firstName: 'Ryan', lastName: 'Allred' },
            ]);

            throw new Error('rollback');
          });
        } catch (e) {}

        const result = await sql`select * from test.users`.many();

        expect(result).toEqual([
          { id: 1, firstName: 'Ryan', lastName: 'Allred' },
        ]);
      });

      const result = await sql`select * from test.users`.maybeMany();

      expect(result).toEqual([
        { id: 1, firstName: 'Ryan', lastName: 'Allred' },
      ]);
    });
  });

  it('supports one', async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.insertValues({
        firstName: 'Ryan',
        lastName: 'Allred',
      })}
    `.exec();

    const result = await sql`select * from test.users`.one();

    expect(result).toEqual({ id: 1, firstName: 'Ryan', lastName: 'Allred' });

    let thrown = null;
    try {
      await sql`select * from test.users where id=${123}`.one();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
  });

  it('supports maybeOne', async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.insertValues({
        firstName: 'Ryan',
        lastName: 'Allred',
      })}
    `.exec();

    const result = await sql`select * from test.users`.maybeOne();

    expect(result).toEqual({ id: 1, firstName: 'Ryan', lastName: 'Allred' });

    expect(
      await sql`select * from test.users where id=${123}`.maybeOne()
    ).toEqual(undefined);
  });

  it('supports many', async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.insertValues({
        firstName: 'Ryan',
        lastName: 'Allred',
      })}
    `.exec();

    const result = await sql`select * from test.users`.many();

    expect(result).toEqual([{ id: 1, firstName: 'Ryan', lastName: 'Allred' }]);

    let thrown = null;
    try {
      await sql`select * from test.users where id=${123}`.many();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
  });

  it('supports maybeMany', async () => {
    await sql`
      create table test.users (
        id serial primary key,
        first_name text not null,
        last_name text not null
      );
    `.exec();

    await sql`
      insert into test.users ${sql.insertValues({
        firstName: 'Ryan',
        lastName: 'Allred',
      })}
    `.exec();

    const result = await sql`select * from test.users`.maybeMany();

    expect(result).toEqual([{ id: 1, firstName: 'Ryan', lastName: 'Allred' }]);

    expect(
      await sql`select * from test.users where id=${123}`.maybeMany()
    ).toEqual([]);
  });
});
