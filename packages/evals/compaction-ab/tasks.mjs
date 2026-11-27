// Long-horizon tasks for the compaction A/B (w125). Each task builds a deterministic local
// world (files in the workspace), a list of wakes (owner prompts sent to the same session in
// turn, as a mission's wakes are), and graders for the deliverable and the recall probe.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// Deterministic filler so documents are long enough to compact, and identical across arms.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const WORDS = "the supplier shall provide goods according to schedule and terms invoice payment net thirty days liability clause notwithstanding force majeure delivery inspection acceptance warranty period returns packaging pallet customs incoterms documentation compliance audit quality batch sample".split(" ");
function filler(seed, words) {
  const r = rng(seed); const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(" ").replace(/((?:\S+ ){18}\S+) /g, "$1.\n");
}
const has = (text, ...patterns) => patterns.every((p) => (p instanceof RegExp ? p : new RegExp(p, "i")).test(text));
const any = (text, ...patterns) => patterns.some((p) => (p instanceof RegExp ? p : new RegExp(p, "i")).test(text));
/** The text of numbered answer n ("3." or "**3.**" at a line start) up to the next numbered answer. */
function answer(probe, n) {
  const lines = probe.split("\n"); let out = [], on = false;
  for (const line of lines) {
    const m = /^\s*(?:[-*]\s*)?\**\s*(\d+)\s*[.)]/.exec(line);
    if (m) on = Number(m[1]) === n;
    if (on) out.push(line);
  }
  return out.join("\n");
}
async function readOr(path) {
  // The agent's shell starts in the session directory, so a relative path lands there (or in artifacts/).
  const { dirname, basename } = await import("node:path"); const { readdir } = await import("node:fs/promises");
  const candidates = [path];
  const sessions = join(dirname(path), "sessions");
  for (const s of await readdir(sessions).catch(() => [])) candidates.push(join(sessions, s, basename(path)), join(sessions, s, "artifacts", basename(path)));
  for (const c of candidates) { try { return await readFile(c, "utf8"); } catch { /* next */ } }
  return "";
}

// ---------------------------------------------------------------- T1 vendor_selection
const VENDORS = [
  ["Kestrel Lights", 19.5, 450, 21, true, "2 years"],
  ["Brightpath Solar", 18.0, 900, 45, false, "1 year"],
  ["Lumora Co", 21.0, 300, 18, true, "3 years"],
  ["Sunward Goods", 17.25, 1200, 30, true, "18 months"],
  ["Heliotrope Ltd", 24.0, 0, 10, true, "2 years"],
  ["Orchard Lamps", 16.5, 1500, 60, true, "1 year"],
  ["Pinecrest Supply", 20.0, 600, 25, false, "2 years"],
  ["Tidewater Energy", 19.0, 700, 20, true, "2 years"],
  ["Marigold Trading", 22.5, 250, 14, true, "1 year"],
  ["Cobalt Ridge", 18.75, 800, 35, true, "3 years"],
];
const vendorSelection = {
  id: "vendor_selection",
  async setup(dir) {
    await mkdir(join(dir, "inbox"), { recursive: true });
    for (const [i, [name, unit, ship, lead, cert, warranty]] of VENDORS.entries()) {
      const n = String(i + 1).padStart(2, "0");
      const body = [
        `QUOTATION ${n} — ${name}`, `Reference: Q-2027-${400 + i}`, "", "General terms", filler(100 + i, 260), "",
        "Commercial offer", `Unit price: USD ${unit.toFixed(2)} per lantern (minimum order 100).`,
        `Shipping to our warehouse: USD ${ship.toLocaleString("en-US")} flat.`, `Lead time: ${lead} days from purchase order.`,
        `Certification: ${cert ? "IEC 62133 certified (certificate attached)" : "IEC 62133 certification pending, not yet issued"}.`,
        `Warranty: ${warranty}.`, "", "Further conditions", filler(200 + i, 300),
      ].join("\n");
      await writeFile(join(dir, "inbox", `quote-${n}.txt`), body);
    }
  },
  wakes: [
    "I'm choosing a supplier for 400 solar lanterns. Hard requirements: total cost (400 units plus shipping) within our budget of $9,000, IEC 62133 certification, and delivery by 14 February; we place the order on 6 January, so lead time must be at most 39 days. Read the quotes in inbox/ one file at a time, starting with quote-01.txt to quote-05.txt today. Keep a shortlist in shortlist.md with each vendor's unit price, shipping, total, lead time and certification.",
    "Some context before you continue: this is project codename BLUE HERON, and my finance contact is Ilse Brandt (she approves the order). If two vendors tie on total cost, prefer the shorter lead time. Now read quote-06.txt to quote-10.txt, one at a time, and update shortlist.md.",
    "Updates from today: Sunward Goods emailed that their shipping is now $1,900 because of a fuel surcharge, and Kestrel Lights raised their unit price to $20.25. Ilse also raised the budget to $9,500. Re-evaluate every vendor against the requirements with these changes, and write your recommendation (vendor, total cost, why) to recommendation.md.",
    "Before I call Ilse, answer these from what you know, numbered, briefly:\n1. What is the project codename?\n2. What was the original budget, and what is it now?\n3. What was Sunward Goods' shipping cost in their original quote?\n4. What was Kestrel Lights' original unit price?\n5. What is Lumora Co's lead time?\n6. Which vendors did not have IEC 62133 certification?\n7. Which vendor did you recommend, and at what total cost?\n8. Who is my finance contact?",
  ],
  async grade(dir, answers) {
    const rec = await readOr(join(dir, "recommendation.md"));
    const probe = answers.at(-1) ?? "";
    const a = (n) => answer(probe, n);
    const q = {
      codename: has(a(1), /blue heron/i),
      budgets: has(a(2), /9,?000/, /9,?500/),
      sunward_original_shipping: has(a(3), /1,?200/),
      kestrel_original_price: has(a(4), /19\.50?\b/),
      lumora_lead: has(a(5), /\b18\b/),
      uncertified: has(a(6), /brightpath/i, /pinecrest/i) && !any(a(6), /kestrel|lumora|sunward|heliotrope|orchard|tidewater|marigold|cobalt/i),
      recommendation: has(a(7), /tidewater/i, /8,?300/),
      finance_contact: has(a(8), /ilse brandt/i),
    };
    return { success: has(rec, /tidewater/i, /8,?300/) && !any(rec.split(/\n/).find((l) => /recommend/i.test(l)) ?? "", /cobalt ridge/i), recall: q };
  },
};

// ---------------------------------------------------------------- T2 incident_logs
const ANOMALIES = {
  3: "03:12:44 host=kiwi-3 level=ERROR code=E-7719 msg=\"disk latency 2.3s on /dev/nvme1\"",
  8: "07:55:10 host=plum-1 level=ERROR code=E-2048 msg=\"TLS handshake timeout to billing-api\"",
  13: "12:30:02 host=kiwi-3 level=ERROR code=E-7719 msg=\"disk latency 4.1s on /dev/nvme1\"",
  19: "18:41:37 host=fig-7 level=CRIT code=E-9001 msg=\"OOM killer invoked, killed pid 4412 (ingest-worker)\"",
  17: "21:05:59 host=plum-1 level=WARN code=W-310 msg=\"TLS certificate expires in 6 days\"",
};
const PEAKS = { "kiwi-3": 71, "plum-1": 88, "fig-7": 64, "pear-2": 93 };
const incidentLogs = {
  id: "incident_logs",
  async setup(dir) {
    await mkdir(join(dir, "logs"), { recursive: true });
    await mkdir(join(dir, "metrics"), { recursive: true });
    const hosts = ["kiwi-3", "plum-1", "fig-7", "pear-2"];
    for (let part = 1; part <= 20; part++) {
      const r = rng(part * 7); const lines = [];
      for (let k = 0; k < 40; k++) {
        const h = Math.floor(part - 1 + k / 40), m = Math.floor(r() * 60), s = Math.floor(r() * 60);
        const hh = String(Math.min(23, Math.floor((part - 1) * 1.2 + k / 34))).padStart(2, "0");
        lines.push(`${hh}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} host=${hosts[Math.floor(r() * 4)]} level=INFO code=I-${100 + Math.floor(r() * 50)} msg="request served in ${Math.floor(r() * 300)}ms route=/api/v${1 + (h % 2)}/items"`);
      }
      if (ANOMALIES[part]) lines.splice(23, 0, ANOMALIES[part]);
      await writeFile(join(dir, "logs", `part-${String(part).padStart(2, "0")}.log`), lines.join("\n") + "\n");
    }
    for (let m = 1; m <= 8; m++) {
      const r = rng(m * 13); const rows = ["timestamp,host,cpu_percent,mem_percent"];
      for (let k = 0; k < 40; k++) {
        const host = hosts[k % 4];
        const cpu = m === 5 && k === 9 ? PEAKS[host] : m === 3 && k === 6 ? PEAKS[host] : m === 7 && k === 4 ? PEAKS[host] : m === 2 && k === 15 ? PEAKS[host] : Math.floor(20 + r() * 40);
        rows.push(`2027-01-0${1 + (m % 8)}T${String(k % 24).padStart(2, "0")}:00:00Z,${host},${cpu},${Math.floor(30 + r() * 30)}`);
      }
      await writeFile(join(dir, "metrics", `m-${String(m).padStart(2, "0")}.csv`), rows.join("\n") + "\n");
    }
  },
  wakes: [
    "We had a bad day in production. Go through logs/part-01.log to logs/part-20.log in order, reading one file per step (for example with cat). Keep track of every line that is not level=INFO. Don't write notes to files; when you've read all twenty, give me the incident summary in chat: each anomaly with its time, host, level, code and message.",
    "Thanks. Now go through metrics/m-01.csv to metrics/m-08.csv, one file per step, and tell me the peak cpu_percent for each host across all eight files.",
    "Before the postmortem, answer from what you know, numbered, briefly:\n1. Which host had the first anomaly of the day, at what time, and with which error code?\n2. Which process did the OOM killer kill, and what was its pid?\n3. How many anomalies did host kiwi-3 have, and what was the worst disk latency?\n4. In how many days does plum-1's TLS certificate expire?\n5. Which host had the highest CPU peak, and what was it?\n6. How many non-INFO lines did you find in total?",
  ],
  async grade(dir, answers) {
    const summary = answers[0] ?? "", probe = answers.at(-1) ?? "";
    const a = (n) => answer(probe, n);
    const q = {
      first_anomaly: has(a(1), /kiwi-3/i, /03:12(:44)?/, /E-7719/i),
      oom_process: has(a(2), /ingest-worker/i, /4412/),
      kiwi_count_latency: has(a(3), /4\.1\s*s/i) && any(a(3), /\b(two|2)\b/i),
      cert_days: has(a(4), /\b(6|six)\b/i),
      cpu_peak: has(a(5), /pear-2/i, /\b93\b/),
      total_anomalies: any(a(6), /\b(five|5)\b/i),
    };
    const listed = [/E-7719/, /E-2048/, /E-9001/, /W-310/].every((p) => p.test(summary)) && /4\.1/.test(summary) && /2\.3/.test(summary);
    const peaks = Object.entries(PEAKS).every(([h, v]) => new RegExp(`${h}[^\\n]{0,40}\\b${v}\\b`, "i").test(answers[1] ?? ""));
    return { success: listed && peaks, recall: q, detail: { listed, peaks } };
  },
};

// ---------------------------------------------------------------- T3 assistant_mission
const EXPENSES = [["software", 1240.5], ["travel", 860], ["office", 312.25], ["training", 450], ["meals", 198.4]];
const assistantMission = {
  id: "assistant_mission",
  async setup(dir) {
    await mkdir(join(dir, "docs"), { recursive: true });
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "docs", "handbook.md"), `# Team handbook\n\n${filler(1, 900)}\n\n## On-call\nThe on-call rotation changes every Tuesday at 10:00.\n\n${filler(2, 600)}\n`);
    const rows = ["date,category,amount_eur,note"]; const r = rng(5);
    for (const [cat, total] of EXPENSES) {
      const parts = 6; let left = Math.round(total * 100);
      for (let k = 0; k < parts; k++) {
        const cents = k === parts - 1 ? left : Math.floor(left / (parts - k) * (0.6 + r() * 0.6)); left -= cents;
        rows.push(`2027-0${1 + (k % 3)}-${String(3 + k * 4).padStart(2, "0")},${cat},${(cents / 100).toFixed(2)},${filler(50 + k, 8).replace(/[\n,.]/g, " ")}`);
      }
    }
    await writeFile(join(dir, "data", "expenses.csv"), rows.join("\n") + "\n");
    const travel = [
      ["QuickHop Travel", "TP 517", 74], ["Iberia direct", "IB 3621", 129], ["SkyBridge Air", "SB 204", 96],
      ["Lufthansa via FRA", "LH 1162", 141], ["RailJet + flight", "RJ 88 / TP 1301", 158], ["Vueling via BCN", "VY 1885", 103],
    ];
    await writeFile(join(dir, "docs", "travel-options.md"), `# Berlin to Lisbon, 14 April\n\n${filler(3, 400)}\n\n` +
      travel.map(([who, flight, eur]) => `## ${who}\nFlight ${flight}. Fare EUR ${eur} including one bag.\n${filler(eur, 120)}\n`).join("\n"));
    for (const [k, items] of [[1, ["Rosa: send the Q1 budget to Jonas by Friday", "Jonas: book the venue"]], [2, ["Mira: draft the newsletter", "Rosa: review the hiring plan"]], [3, ["Rosa: renew the domain crowdlantern.org", "Jonas: order the badges"]]]) {
      await writeFile(join(dir, "docs", `meeting-notes-${k}.md`), `# Meeting ${k}\n\n${filler(10 + k, 350)}\n\n## Action items\n${items.map((i) => `- ${i}`).join("\n")}\n\n${filler(20 + k, 250)}\n`);
    }
    await writeFile(join(dir, "docs", "reading-list.md"), `# Reading list\n\n${filler(30, 300)}\n\n${["Statistical Rethinking", "The Art of Statistics", "Naked Statistics", "Gödel, Escher, Bach", "Thinking in Systems", "All of Statistics", "The Design of Everyday Things"].map((b, i) => `${i + 1}. ${b} — ${filler(40 + i, 60)}`).join("\n")}\n`);
  },
  wakes: [
    "Hi, I'm Rosa. Please read docs/handbook.md and save a five-bullet summary to handbook-summary.md.",
    "Something to remember for later: my sister Ilse's birthday is 3 March 1990; she loves birdwatching and dislikes chocolate. And please always write dates as DD.MM.YYYY for me. Now: read data/expenses.csv and write the total per category to totals.md.",
    "Read docs/travel-options.md and tell me the cheapest way from Berlin to Lisbon on 14 April. I never use QuickHop Travel, so leave them out. By the way, my gift budget is €60 per person.",
    "Read docs/meeting-notes-1.md, docs/meeting-notes-2.md and docs/meeting-notes-3.md and list the action items assigned to me.",
    "Read docs/reading-list.md and pick the three best books on statistics for a beginner, with one line each.",
    "Plan my sister's birthday gift: write gift-plan.md with her birthday date and two gift ideas with prices.",
    "Quick questions, answer from what you know, numbered, briefly:\n1. What is my sister's name, and what year was she born?\n2. What was the cheapest travel option you found, with its price and flight number?\n3. What was the total for the software category?\n4. How do I want dates written?\n5. Which travel agency must you never use?\n6. What is my gift budget per person?\n7. When does the on-call rotation change?",
  ],
  async grade(dir, answers) {
    const plan = await readOr(join(dir, "gift-plan.md"));
    const probe = answers.at(-1) ?? "";
    const prices = [...plan.matchAll(/(?:€|EUR\s?)(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s?(?:€|EUR)/gi)].map((m) => Number((m[1] ?? m[2]).replace(",", ".")));
    // A gift idea is a list item; it proposes chocolate if its name (before ":" or a dash) does.
    const ideas = plan.split("\n").filter((line) => /^\s*([-*]|\d+[.)])\s+/.test(line));
    const proposesChocolate = ideas.some((line) => /chocolate/i.test(line.split(/[:—–]| - /)[0]));
    const giftOk = /03\.03\./.test(plan) && /ilse/i.test(plan) && !proposesChocolate
      && /bird/i.test(plan) && prices.length > 0 && prices.every((p) => p <= 60);
    const a = (n) => answer(probe, n);
    const q = {
      sister: has(a(1), /ilse/i, /1990/),
      travel: has(a(2), /\b96\b/, /SB ?204/i),
      software_total: has(a(3), /1[ ,.]?240[.,]50?/),
      date_format: has(a(4), /DD\.MM\.YYYY/i),
      never_agency: has(a(5), /quickhop/i),
      gift_budget: has(a(6), /\b60\b/),
      oncall: has(a(7), /tuesday/i, /10:00|10 ?am/i),
    };
    return { success: giftOk, recall: q, detail: { giftOk, prices } };
  },
};

export const TASKS = { vendor_selection: vendorSelection, incident_logs: incidentLogs, assistant_mission: assistantMission };
