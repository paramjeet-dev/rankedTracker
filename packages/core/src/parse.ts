/**
 * ALL assumptions about response shapes live in this file. Field names below come from the user's samples
 * (history, group members, attack/defense log entries); the top-level keys of the profile and group payloads
 * are best guesses and are verified at runtime: a mismatch throws ParseError (the raw response is already saved).
 */
import { attackerTrophies, defenderTrophies, normalizeTag } from "@coc/shared";

export class ParseError extends Error {}
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
const tag = (v: unknown) => (typeof v === "string" && v ? normalizeTag(v) : null);

export interface GroupRef { groupTag: string; seasonId: number }
export interface Profile { tag: string; name: string; clanTag: string | null; trophies: number | null; tierId: number | null; townHall: number | null; current: GroupRef | null; previous: GroupRef | null }

function ref(g: unknown, s: unknown): GroupRef | null {
  // "#0" means "not in a group"
  const groupTag = typeof g === "string" && g && g !== "#0" && g !== "0" ? g : null; const seasonId = num(s);
  return groupTag && seasonId ? { groupTag, seasonId } : null;
}

export function parseProfile(p: any): Profile {
  if (!p?.tag) throw new ParseError(`profile without tag; keys=${Object.keys(p ?? {})}`);
  return { tag: normalizeTag(p.tag), name: p.name, clanTag: tag(p.clan?.tag), trophies: num(p.trophies), tierId: num(p.leagueTier?.id), townHall: num(p.townHallLevel),
    current: ref(p.currentLeagueGroupTag, p.currentLeagueSeasonId), previous: ref(p.previousLeagueGroupTag, p.previousLeagueSeasonId) };
}

export interface HistoryRow { seasonId: number; tierId: number; trophies: number; placement: number; attackWins: number; attackLosses: number; defenseWins: number; defenseLosses: number; defenseStars: number; maxBattles: number }
export function parseHistory(j: any): HistoryRow[] {
  const items = Array.isArray(j) ? j : j?.items;
  if (!Array.isArray(items)) throw new ParseError(`history: no items array; keys=${Object.keys(j ?? {})}`);
  return items.map((i: any) => ({ seasonId: Number(i.leagueSeasonId), tierId: Number(i.leagueTierId), trophies: Number(i.leagueTrophies), placement: Number(i.placement),
    attackWins: Number(i.attackWins), attackLosses: Number(i.attackLosses), defenseWins: Number(i.defenseWins), defenseLosses: Number(i.defenseLosses),
    defenseStars: Number(i.defenseStars), maxBattles: Number(i.maxBattles) })); // attackStars deliberately dropped (always 0)
}

export interface Member { playerTag: string; playerName: string; clanTag: string | null; clanName: string | null; trophies: number; atkWin: number; atkLoss: number; defWin: number; defLoss: number }
export interface Battle { attacker: string; defender: string; time: string; stars: number; destruction: number; attackerGain: number; defenderGain: number; atkRep: number | null; defRep: number | null }
export interface Group { members: Member[]; battles: Battle[] }

const firstArray = (o: any, ...names: string[]) => { for (const n of names) if (Array.isArray(o?.[n])) return o[n] as any[]; return null; };

const fin = (v: unknown, what: string): number => {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n)) throw new ParseError(`group: missing/invalid ${what} (got ${JSON.stringify(v)})`);
  return n;
};

export function parseGroup(j: any, probeTag: string): Group {
  const root = j?.leagueGroup ?? j;
  const rawMembers = firstArray(root, "members");
  const atk = firstArray(root, "attackLogs", "attackLog", "attacks");
  const def = firstArray(root, "defenseLogs", "defenseLog", "defenceLogs", "defenceLog", "defenses");
  if (!rawMembers || !atk || !def) throw new ParseError(`group: unexpected shape; top-level keys=${Object.keys(root ?? {})}`);
  const probe = normalizeTag(probeTag);
  const members: Member[] = rawMembers.map((m: any) => {
    if (typeof m.playerTag !== "string") throw new ParseError(`group: member without playerTag; keys=${Object.keys(m ?? {})}`);
    return { playerTag: normalizeTag(m.playerTag), playerName: m.playerName ?? null, clanTag: tag(m.clanTag), clanName: m.clanName ?? null,
      trophies: fin(m.leagueTrophies, "leagueTrophies"), atkWin: fin(m.attackWinCount, "attackWinCount"), atkLoss: fin(m.attackLoseCount, "attackLoseCount"),
      defWin: fin(m.defenseWinCount, "defenseWinCount"), defLoss: fin(m.defenseLoseCount, "defenseLoseCount") };
  });
  const byKey = new Map<string, Battle>();
  const add = (attacker: string, defender: string, e: any, side: "atk" | "def") => {
    if (typeof e.opponentPlayerTag !== "string") throw new ParseError(`group: log entry without opponentPlayerTag; keys=${Object.keys(e ?? {})}`);
    const stars = fin(e.stars, "stars"), destruction = fin(e.destructionPercentage, "destructionPercentage");
    const d = new Date(e.creationTime); if (Number.isNaN(d.getTime())) throw new ParseError(`group: bad creationTime ${JSON.stringify(e.creationTime)}`);
    const time = d.toISOString();
    const key = `${attacker}|${defender}|${time}`;
    const rep = e.trophies === undefined || e.trophies === null ? null : Number(e.trophies);
    const b = byKey.get(key) ?? { attacker, defender, time, stars, destruction, attackerGain: attackerTrophies(stars, destruction), defenderGain: defenderTrophies(stars, destruction), atkRep: null, defRep: null };
    if (side === "atk") b.atkRep = rep; else b.defRep = rep;
    byKey.set(key, b);
  };
  for (const e of atk) add(probe, normalizeTag(e.opponentPlayerTag), e, "atk"); // probe attacked opponent
  for (const e of def) add(normalizeTag(e.opponentPlayerTag), probe, e, "def"); // opponent attacked probe
  return { members, battles: [...byKey.values()] };
}
