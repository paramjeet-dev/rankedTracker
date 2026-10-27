import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PgDiscoveryRepo } from '../src/discovery/repo.js';

// Integration tests. They need a Postgres with the project's base tables; they skip otherwise.
const url = process.env['TEST_DATABASE_URL'];
const skip = url ? false : 'set TEST_DATABASE_URL to run';
const MIN = 105000026;
const MAX = 105000033;
let pool: pg.Pool;
let repo: PgDiscoveryRepo;

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 4 });
  await pool.query(readFileSync('sql/001_discovery_state.sql', 'utf8'));
  repo = new PgDiscoveryRepo(pool, { minTier: MIN, maxTier: MAX, refreshDays: 7 });
});
after(async () => void (await pool?.end()));
beforeEach(async () => {
  if (!url) return;
  await pool.query('TRUNCATE group_member, league_group, player, clan CASCADE');
});

test('migration is idempotent', { skip }, async () => {
  await pool.query(readFileSync('sql/001_discovery_state.sql', 'utf8'));
  await pool.query(readFileSync('sql/001_discovery_state.sql', 'utf8'));
});

test('new pool: keyset pages ordered by tag, skips crawled, invalid and backed-off clans', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag, members_crawled_at, invalid_at, next_attempt_at) VALUES
    ('#A1', NULL, NULL, NULL), ('#A2', NULL, NULL, NULL), ('#A3', now(), NULL, NULL),
    ('#A4', NULL, now(), NULL), ('#A5', NULL, NULL, now() + interval '1 hour'), ('#A6', NULL, NULL, now() - interval '1 hour'),
    ('#A7', NULL, NULL, NULL)`);
  assert.deepEqual(await repo.loadTargets('new', '', 2), ['#A1', '#A2']);
  assert.deepEqual(await repo.loadTargets('new', '#A2', 10), ['#A6', '#A7']);
  assert.equal(await repo.countTargets('new'), 4);
});

test('refresh pool: only clans crawled more than refreshDays ago', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag, members_crawled_at) VALUES
    ('#R1', now() - interval '10 days'), ('#R2', now() - interval '1 day'), ('#R3', NULL)`);
  assert.deepEqual(await repo.loadTargets('refresh', '', 10), ['#R1']);
  assert.equal(await repo.countTargets('refresh'), 1);
});

test('saveClan: inserts in-scope players only, never overwrites names, updates tiers of known players', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag) VALUES ('#C1')`);
  await pool.query(`INSERT INTO player (player_tag, name, tier_id, last_seen) VALUES
    ('#KNOWN', 'Old Name', ${MIN}, now() - interval '3 days'),
    ('#LEFT', 'Left', ${MAX}, now() - interval '3 days')`);
  const res = await repo.saveClan('#C1', 'Clan One', [
    { tag: '#NEW', name: 'New', tierId: MIN + 2 },
    { tag: '#KNOWN', name: 'Renamed', tierId: MIN + 1 },
    { tag: '#LEFT', name: 'Left', tierId: 105000036 }, // promoted out of scope
    { tag: '#LOW', name: 'Low', tierId: 105000010 } // out of scope, unknown -> must not be inserted
  ]);
  assert.equal(res.inserted, 1);
  assert.equal(res.tierUpdated, 2);
  const rows = (await pool.query('SELECT player_tag, name, tier_id FROM player ORDER BY player_tag')).rows;
  assert.deepEqual(rows.map((r) => r.player_tag), ['#KNOWN', '#LEFT', '#NEW']);
  assert.equal(rows.find((r) => r.player_tag === '#KNOWN').name, 'Old Name', 'name history belongs to the profile process');
  assert.equal(Number(rows.find((r) => r.player_tag === '#KNOWN').tier_id), MIN + 1);
  assert.equal(Number(rows.find((r) => r.player_tag === '#LEFT').tier_id), 105000036);
  const clan = (await pool.query(`SELECT name, members_crawled_at, member_count, fail_count FROM clan WHERE clan_tag='#C1'`)).rows[0];
  assert.equal(clan.name, 'Clan One');
  assert.ok(clan.members_crawled_at);
  assert.equal(clan.member_count, 4);
});

test('saving an unchanged roster twice causes no player writes', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag) VALUES ('#C2')`);
  const roster = [{ tag: '#P1', name: 'One', tierId: MIN }];
  const first = await repo.saveClan('#C2', 'C2', roster);
  assert.equal(first.inserted, 1);
  const xminBefore = (await pool.query(`SELECT xmin::text AS x FROM player WHERE player_tag='#P1'`)).rows[0].x;
  const second = await repo.saveClan('#C2', 'C2', roster);
  assert.deepEqual(second, { inserted: 0, tierUpdated: 0 });
  const xminAfter = (await pool.query(`SELECT xmin::text AS x FROM player WHERE player_tag='#P1'`)).rows[0].x;
  assert.equal(xminAfter, xminBefore, 'row must not have been rewritten');
});

test('concurrent saves with overlapping players do not deadlock', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag) VALUES ('#X1'), ('#X2'), ('#X3'), ('#X4')`);
  const players = Array.from({ length: 40 }, (_, i) => ({ tag: `#Z${String(i).padStart(2, '0')}`, name: 'z', tierId: MIN }));
  const rev = [...players].reverse();
  await Promise.all([
    repo.saveClan('#X1', 'x', players), repo.saveClan('#X2', 'x', rev),
    repo.saveClan('#X3', 'x', players), repo.saveClan('#X4', 'x', rev)
  ]);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM player')).rows[0].n), 40);
});

test('recordFailure backs off exponentially and markInvalid removes the clan from both pools', { skip }, async () => {
  await pool.query(`INSERT INTO clan (clan_tag) VALUES ('#F1'), ('#F2')`);
  await repo.recordFailure('#F1');
  const a = (await pool.query(`SELECT fail_count, extract(epoch FROM next_attempt_at - now()) AS s FROM clan WHERE clan_tag='#F1'`)).rows[0];
  assert.equal(a.fail_count, 1);
  assert.ok(a.s > 50 && a.s <= 60, `first backoff ~1 min, got ${a.s}`);
  await repo.recordFailure('#F1');
  const b = (await pool.query(`SELECT fail_count, extract(epoch FROM next_attempt_at - now()) AS s FROM clan WHERE clan_tag='#F1'`)).rows[0];
  assert.equal(b.fail_count, 2);
  assert.ok(b.s > 110 && b.s <= 120, `second backoff ~2 min, got ${b.s}`);
  assert.deepEqual(await repo.loadTargets('new', '', 10), ['#F2']);
  await repo.markInvalid('#F2');
  assert.deepEqual(await repo.loadTargets('new', '', 10), []);
});

test('tagFormatProblem flags tags stored without "#"', { skip }, async () => {
  assert.equal(await repo.tagFormatProblem(), null);
  await pool.query(`INSERT INTO player (player_tag) VALUES ('ABC123')`);
  assert.match((await repo.tagFormatProblem()) ?? '', /do not start with "#"/);
});
