import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

await mkdir(new URL("./dist/server/", import.meta.url), { recursive: true });
await mkdir(new URL("./dist/.openai/", import.meta.url), { recursive: true });

const worker = `const html = ${JSON.stringify(html)};

const teamIds = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113, CLE: 114,
  COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119, MIA: 146, MIL: 158,
  MIN: 142, NYM: 121, NYY: 147, ATH: 133, PHI: 143, PIT: 134, SD: 135, SF: 137,
  SEA: 136, STL: 138, TB: 139, TEX: 140, TOR: 141, WSH: 120
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=900" : "no-store"
    }
  });
}

function playerPhotoUrl(playerId) {
  return playerId ? "https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_100/v1/people/" + playerId + "/headshot/67/current" : "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fixed(value, digits = 1) {
  const n = num(value);
  return n === null ? "" : n.toFixed(digits);
}

function parseInnings(value) {
  const text = clean(value);
  if (!text) return 0;
  const parts = text.split(".");
  const whole = Number(parts[0]) || 0;
  const outs = Number(parts[1] || 0);
  return whole + Math.min(outs, 2) / 3;
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text) {
  const lines = text.split(/\\r?\\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(clean);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = clean(values[index]);
    });
    return row;
  });
}

async function handleSavant(url) {
  const start = url.searchParams.get("start") || "2026-07-01";
  const end = url.searchParams.get("end") || "2026-08-02";
  const team = (url.searchParams.get("team") || "").toUpperCase();
  const source = new URL("https://baseballsavant.mlb.com/statcast_search/csv");
  source.search = "all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7CPO%7CS%7C=&hfSea=&hfSit=&player_type=batter&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&";
  source.searchParams.set("game_date_gt", start);
  source.searchParams.set("game_date_lt", end);
  if (team) source.searchParams.set("team", team);

  const response = await fetch(source.toString(), {
    headers: { "user-agent": "Mozilla/5.0 MLB trade value research tool" }
  });
  if (!response.ok) throw new Error("Baseball Savant 暫時無法回應");
  const rows = parseCsv(await response.text());
  const groups = new Map();

  rows.forEach(row => {
    const name = clean(row.player_name || row.batter_name || row.name);
    if (!name) return;
    const playerId = clean(row.batter || row.player_id || row.mlbam_id);
    const key = playerId || name;
    const group = groups.get(key) || {
      name,
      playerId,
      sourceLabel: "Baseball Savant",
      source: "savant",
      type: "hitter",
      level: "MLB",
      team: team || clean(row.home_team || row.away_team),
      events: 0,
      hr: 0,
      evSum: 0,
      evCount: 0,
      xwobaSum: 0,
      xwobaCount: 0
    };
    group.events += 1;
    if (row.events === "home_run") group.hr += 1;
    const ev = num(row.launch_speed);
    if (ev !== null) {
      group.evSum += ev;
      group.evCount += 1;
    }
    const xwoba = num(row.estimated_woba_using_speedangle);
    if (xwoba !== null) {
      group.xwobaSum += xwoba;
      group.xwobaCount += 1;
    }
    groups.set(key, group);
  });

  const out = Array.from(groups.values())
    .map(row => {
      const avgEv = row.evCount ? row.evSum / row.evCount : null;
      const xwoba = row.xwobaCount ? row.xwobaSum / row.xwobaCount : null;
      return {
        name: row.name,
        playerId: row.playerId,
        photoUrl: playerPhotoUrl(row.playerId),
        sourceLabel: row.sourceLabel,
        source: row.source,
        type: row.type,
        level: row.level,
        team: row.team,
        age: "",
        hr: row.hr,
        ops: "",
        obp: "",
        slg: "",
        wrcPlus: "",
        summary: "BIP " + row.events + " / Avg EV " + (avgEv === null ? "-" : avgEv.toFixed(1)) + " / xwOBA " + (xwoba === null ? "-" : xwoba.toFixed(3))
      };
    })
    .sort((a, b) => Number(b.hr || 0) - Number(a.hr || 0))
    .slice(0, 80);

  return json({ source: "Baseball Savant Statcast", rows: out });
}

async function fetchMlbStats(group, teamId) {
  const endpoint = new URL("https://statsapi.mlb.com/api/v1/stats");
  endpoint.searchParams.set("stats", "season");
  endpoint.searchParams.set("group", group);
  endpoint.searchParams.set("playerPool", "ALL");
  endpoint.searchParams.set("sportIds", "11,12,13,14");
  endpoint.searchParams.set("limit", "50");
  endpoint.searchParams.set("hydrate", "team,person");
  endpoint.searchParams.set("sortStat", group === "hitting" ? "ops" : "strikeOuts");
  endpoint.searchParams.set("order", "desc");
  if (teamId) endpoint.searchParams.set("teamId", teamId);
  const response = await fetch(endpoint.toString(), {
    headers: { "user-agent": "Mozilla/5.0 MLB trade value research tool" }
  });
  if (!response.ok) throw new Error("MLB/MiLB 資料暫時無法回應");
  const payload = await response.json();
  return payload?.stats?.[0]?.splits || [];
}

function prospectRow(split, type) {
  const stat = split.stat || {};
  const person = split.player || split.person || {};
  const team = split.team || {};
  const playerId = clean(person.id || split.playerId);
  const name = clean(person.fullName || person.name || split.player?.fullName);
  if (!name) return null;
  const age = clean(person.currentAge || "");
  const level = clean(split.sport?.abbreviation || split.sport?.name || team.name || "MiLB");

  if (type === "pitcher") {
    const ip = parseInnings(stat.inningsPitched);
    const strikeouts = num(stat.strikeOuts) || 0;
    const walks = num(stat.baseOnBalls) || 0;
    const homers = num(stat.homeRuns) || 0;
    return {
      name,
      playerId,
      photoUrl: playerPhotoUrl(playerId),
      sourceLabel: "MLB/MiLB Stats",
      source: "prospects",
      type: "pitcher",
      level,
      team: clean(team.name),
      age,
      era: clean(stat.era),
      fip: "",
      ip: fixed(stat.inningsPitched, 1),
      k9: ip ? (strikeouts * 9 / ip).toFixed(1) : "",
      bb9: ip ? (walks * 9 / ip).toFixed(1) : "",
      hr9: ip ? (homers * 9 / ip).toFixed(1) : "",
      summary: "IP " + clean(stat.inningsPitched) + " / SO " + strikeouts + " / WHIP " + clean(stat.whip || "-")
    };
  }

  return {
    name,
    playerId,
    photoUrl: playerPhotoUrl(playerId),
    sourceLabel: "MLB/MiLB Stats",
    source: "prospects",
    type: "hitter",
    level,
    team: clean(team.name),
    age,
    hr: clean(stat.homeRuns),
    ops: clean(stat.ops),
    obp: clean(stat.obp),
    slg: clean(stat.slg),
    sb: clean(stat.stolenBases),
    wrcPlus: "",
    summary: "AVG " + clean(stat.avg || "-") + " / RBI " + clean(stat.rbi || "-") + " / PA " + clean(stat.plateAppearances || "-")
  };
}

async function handleProspects(url) {
  const requestedTeamId = clean(url.searchParams.get("teamId"));
  const teamId = requestedTeamId || "";
  const [hitters, pitchers] = await Promise.all([
    fetchMlbStats("hitting", teamId),
    fetchMlbStats("pitching", teamId)
  ]);
  const rows = [
    ...hitters.map(split => prospectRow(split, "hitter")),
    ...pitchers.map(split => prospectRow(split, "pitcher"))
  ].filter(Boolean).slice(0, 100);

  return json({
    source: "MLB/MiLB Prospects & Stats",
    rows
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/savant") return await handleSavant(url);
      if (url.pathname === "/api/prospects") return await handleProspects(url);
    } catch (error) {
      return json({ error: error.message || "資料載入失敗", rows: [] }, 502);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=60"
        }
      });
    }

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
`;

await writeFile(new URL("./dist/server/index.js", import.meta.url), worker, "utf8");
await copyFile(
  new URL("./.openai/hosting.json", import.meta.url),
  new URL("./dist/.openai/hosting.json", import.meta.url)
);
