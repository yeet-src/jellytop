// jellytop: top(1) for your Jellyfin transcodes, answered by the kernel.
//
//   yeet run ./main.tsx                       # live view
//   yeet run ./main.tsx -- --container jf     # a differently named container
//   yeet run ./main.tsx | cat                 # one text snapshot per tick
//
// Every number here comes from the system graph: /proc, docker, hwmon.
// No Jellyfin API, no log parsing, no agent inside the container.

import { Box, Text, mount, signal } from "yeet:tui";

const CORES = signal(1);

const CONTAINER = String(yeet.args.container ?? "jellyfin");
const INTERVAL = Number(yeet.args.interval ?? 1000);
const RENDER_NODE = /^\/dev\/dri\/renderD\d+$/;

// ---- one-shot facts -------------------------------------------------------

async function containerId(name) {
  const { data } = await yeet.graph.query(`{
    docker { list_containers { id names } }
  }`);
  const c = (data?.docker?.list_containers ?? []).find((c) =>
    (c.names ?? []).some((n) => n.replace(/^\//, "") === name),
  );
  if (!c) throw new Error(`no running container named "${name}"`);
  return c.id;
}

function startBoxWatch() {
  yeet.graph.subscribe(
    `subscription { load_average(interval_ms: ${INTERVAL}) { one five fifteen } }`,
    (d) => { if (!d.__error) box.update((b) => ({ ...b, load: (d.data ?? d).load_average })); },
  );
  yeet.graph.subscribe(
    `subscription { meminfo(interval_ms: ${INTERVAL}) { mem_total mem_available swap_total swap_free } }`,
    (d) => {
      if (d.__error) return;
      const m = (d.data ?? d).meminfo;
      box.update((b) => ({ ...b, memAvail: m.mem_available, memTotal: m.mem_total, swapUsed: m.swap_total - m.swap_free }));
    },
  );
  yeet.graph.subscribe(
    `subscription { cpu(interval_ms: ${INTERVAL}) { cores { cpufreq { scaling_cur_freq scaling_max_freq } } } }`,
    (d) => {
      if (d.__error) return;
      const f = ((d.data ?? d).cpu?.cores ?? []).map((c) => c.cpufreq).filter(Boolean);
      if (!f.length) return;
      const avg = f.reduce((a, c) => a + c.scaling_cur_freq, 0) / f.length / 1e6;
      box.update((b) => ({ ...b, ghz: avg, ghzMax: f[0].scaling_max_freq / 1e6 }));
    },
  );
  let last = null;
  yeet.graph.subscribe(
    `subscription { network_interface_stats(interval_ms: ${INTERVAL}) { name recv_bytes sent_bytes } }`,
    (d) => {
      if (d.__error) return;
      const now = Date.now();
      // The busiest physical interface is the one the clients are on.
      const phys = ((d.data ?? d).network_interface_stats ?? []).filter((i) => !VIRTUAL.test(i.name));
      const cur = Object.fromEntries(phys.map((i) => [i.name, i]));
      if (last) {
        const dt = (now - last.t) / 1000;
        let best = null;
        for (const [name, i] of Object.entries(cur)) {
          const p = last.cur[name];
          if (!p) continue;
          const rx = (i.recv_bytes - p.recv_bytes) / dt;
          const tx = (i.sent_bytes - p.sent_bytes) / dt;
          const total = i.recv_bytes + i.sent_bytes;
          if (!best || total > best.total) best = { name, rx, tx, total };
        }
        if (best) box.update((b) => ({ ...b, iface: best.name, rxBps: best.rx, txBps: best.tx }));
      }
      last = { t: now, cur };
    },
  );
}

async function ticksPerSecond() {
  const { data } = await yeet.graph.query(`{ host { ticks_per_second } }`);
  return data.host.ticks_per_second;
}

// Looked up once per pid and cached. ffmpeg opens the render node before the
// first frame and holds it until exit, so one look answers the GPU question,
// and a process does not change cgroup mid-transcode. Looking these up per
// pid rather than in the bulk subscription also sidesteps the race where a
// process exits between the /proc walk and the read of its cgroup file.
const facts = new Map();
async function factsFor(pid, containerId) {
  if (facts.has(pid)) return facts.get(pid);
  let f = { gpu: false, inContainer: false, argv: [] };
  try {
    const { data } = await yeet.graph.query(`{
      proc(pid: ${pid}) { cmdline cgroups { pathname } fds { kind path } }
    }`);
    f = {
      argv: data?.proc?.cmdline ?? [],
      gpu: (data?.proc?.fds ?? []).some(
        (x) => x.kind === "PATH" && RENDER_NODE.test(x.path ?? ""),
      ),
      inContainer: (data?.proc?.cgroups ?? []).some((c) =>
        c.pathname.includes(containerId),
      ),
    };
  } catch {
    /* it exited; the next tick forgets it */
  }
  facts.set(pid, f);
  return f;
}

// ---- reading the ffmpeg command line --------------------------------------

function describe(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const input = argv.find((a) => a.startsWith("file:"))?.slice(5) ?? "?";
  const vcodec = flag("-codec:v:0") ?? flag("-c:v") ?? "copy";
  const hwaccel = flag("-hwaccel") ?? "none";
  const vf = flag("-vf") ?? "";
  // hardware filters say scale_vaapi=w=1280:h=720; the software path says
  // scale=trunc(min(max(iw\,ih*a)\,1280)/2)*2:... so take whichever appears.
  const hw = vf.match(/scale(?:_vaapi|_qsv|_cuda)?=w=(\d+):h=(\d+)/);
  const sw = vf.match(/scale=trunc\(min\(max\(iw\\,ih\*a\)\\,(\d+)\)/);
  const bitrate = Number(flag("-b:v") ?? flag("-maxrate") ?? 0);
  const hwEncode = /_(qsv|vaapi|nvenc|amf|v4l2m2m|videotoolbox)$/.test(vcodec);
  const hwDecode = hwaccel !== "none";
  const mode = hwDecode && hwEncode ? "hw" : hwEncode || hwDecode ? "mixed" : "sw";
  return {
    file: input.split("/").pop(),
    vcodec,
    hwaccel,
    mode,
    target: hw ? `${hw[1]}x${hw[2]}` : sw ? `${sw[1]}w` : "source",
    kbps: bitrate ? Math.round(bitrate / 1000) : null,
  };
}

// ---- the live model -------------------------------------------------------

const state = signal({ sessions: [], others: [], temp: null, tick: 0 });
// Box-level facts a media server owner cares about: is it swapping, is the
// clock throttled, how much is leaving the NIC, how many clients are on.
const box = signal({
  load: null, memAvail: null, memTotal: null, swapUsed: null,
  ghz: null, ghzMax: null, iface: null, rxBps: 0, txBps: 0,
});
const VIRTUAL = /^(lo|veth|br-|docker|virbr|tailscale|wg|tun|tap|cni|flannel|kube)/;
const HIST = 24;
const cpuHist = new Map(); // pid -> last HIST cpu samples
const tempHist = [];

async function main() {
  // jellytop is for signed-in hosts. The token never reaches the isolate;
  // whoami only says whether the daemon has one.
  const me = await yeet.whoami();
  if (me === null) {
    console.error("jellytop: this host is not signed in to yeet. Run `yeet login` and try again.");
    yeet.exit();
    return;
  }
  const id = await containerId(CONTAINER);
  const hz = await ticksPerSecond();
  startBoxWatch();
  {
    const { data } = await yeet.graph.query(`{ cpu { num_cores } }`);
    CORES.set(data?.cpu?.num_cores ?? 1);
  }
  const prev = new Map(); // pid -> { cpu ticks, read_bytes, write_bytes, t }

  yeet.graph.subscribe(
    `subscription {
      hwmons(by: { name: "coretemp" }, interval_ms: ${INTERVAL}) {
        temps { name input }
      }
    }`,
    (d) => {
      if (d.__error) return;
      const pkg = ((d.data ?? d).hwmons ?? [])
        .flatMap((h) => h.temps)
        .find((t) => /^Package/.test(t.name));
      if (pkg) {
        tempHist.push(pkg.input / 1000);
        if (tempHist.length > HIST) tempHist.shift();
        state.update((s) => ({ ...s, temp: pkg.input / 1000 }));
      }
    },
  );

  yeet.graph.subscribe(
    `subscription {
      procs(interval_ms: ${INTERVAL}) {
        pid
        stat { comm utime stime num_threads }
        io { read_bytes write_bytes }
      }
    }`,
    async (d) => {
      if (d.__error) {
        console.error(String(d.__error?.message ?? d.__error));
        return;
      }
      const now = Date.now();
      const rows = [];
      const live = new Set();
      for (const p of (d.data ?? d).procs ?? []) {
        if (!p.stat) continue;
        live.add(p.pid);
        const cpuTicks = p.stat.utime + p.stat.stime;
        const last = prev.get(p.pid);
        prev.set(p.pid, {
          cpuTicks,
          read: p.io?.read_bytes ?? 0,
          write: p.io?.write_bytes ?? 0,
          t: now,
        });
        if (!last) continue;
        const dt = (now - last.t) / 1000;
        rows.push({
          p,
          cpu: ((cpuTicks - last.cpuTicks) / hz / dt) * 100,
          readBps: ((p.io?.read_bytes ?? 0) - last.read) / dt,
          writeBps: ((p.io?.write_bytes ?? 0) - last.write) / dt,
        });
      }

      if (yeet.args.debug) {
        const top = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 3);
        console.error(`debug rows=${rows.length} hz=${hz} top=${JSON.stringify(top.map((r) => [r.p.pid, r.p.stat.comm, r.cpu.toFixed(1)]))} ffmpeg=${rows.filter((r) => r.p.stat.comm === "ffmpeg").length}`);
      }
      // Only ffmpeg and anything busy gets the per-pid lookup.
      for (const r of rows) {
        if (r.p.stat.comm === "ffmpeg" || r.cpu >= 5) {
          const f = await factsFor(r.p.pid, id);
          r.inContainer = f.inContainer;
          r.gpu = f.gpu;
          r.argv = f.argv;
        }
      }

      const sessions = [];
      for (const r of rows) {
        if (!r.inContainer || r.p.stat.comm !== "ffmpeg") continue;
        const h = cpuHist.get(r.p.pid) ?? [];
        h.push(r.cpu);
        if (h.length > HIST) h.shift();
        cpuHist.set(r.p.pid, h);
        sessions.push({
          pid: r.p.pid,
          ...describe(r.argv),
          gpu: r.gpu,
          threads: r.p.stat.num_threads,
          cpu: r.cpu,
          readBps: r.readBps,
          writeBps: r.writeBps,
        });
      }

      // Everything else on the box that is burning CPU right now, so a slow
      // stream can be blamed on the right process.
      const others = rows
        .filter((r) => !(r.inContainer && r.p.stat.comm === "ffmpeg"))
        .filter((r) => r.cpu >= 5)
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 5)
        .map((r) => ({
          pid: r.p.pid,
          comm: r.p.stat.comm,
          cpu: r.cpu,
          readBps: r.readBps,
          where: r.inContainer ? CONTAINER : "host",
        }));

      for (const pid of [...prev.keys()])
        if (!live.has(pid)) {
          prev.delete(pid);
          facts.delete(pid);
          cpuHist.delete(pid);
        }

      state.update((s) => ({ ...s, sessions, others, tick: s.tick + 1 }));
    },
  );
}

// ---- rendering ------------------------------------------------------------

const mb = (bps) => `${(bps / 1e6).toFixed(1)} MB/s`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const rpad = (s, n) => String(s).padStart(n);

const gb = (n) => `${(n / 1073741824).toFixed(1)}G`;
function boxLine() {
  const b = box.get();
  const parts = [];
  if (b.load) parts.push(`load ${b.load.one.toFixed(1)} ${b.load.five.toFixed(1)} ${b.load.fifteen.toFixed(1)}`);
  if (b.memAvail != null) parts.push(`mem ${gb(b.memAvail)} free`);
  if (b.swapUsed != null) parts.push(`swap ${gb(b.swapUsed)} used`);
  if (b.ghz != null) parts.push(`cpu ${b.ghz.toFixed(1)}/${b.ghzMax.toFixed(1)} GHz`);
  if (b.iface) parts.push(`net ↓${mb(b.rxBps)} ↑${mb(b.txBps)} ${b.iface}`);
  return parts.join("   ");
}

function lines(s) {
  const out = [];
  const temp = s.temp == null ? "" : `   cpu pkg ${s.temp.toFixed(0)}°C`;
  out.push(`jellytop  container=${CONTAINER}  transcodes=${s.sessions.length}${temp}`);
  out.push(`  ${boxLine()}`);
  out.push("");
  if (s.sessions.length === 0) {
    out.push("  no ffmpeg running in the container (direct play, or nobody watching)");
  } else {
    out.push(
      `  ${pad("PID", 8)}${pad("MODE", 7)}${pad("DRI", 6)}${pad("DECODE", 8)}${pad("ENCODE", 11)}${pad("TARGET", 15)}${rpad("CPU%", 6)}${rpad("THR", 4)}${rpad("READ", 11)}${rpad("WRITE", 11)}  FILE`,
    );
    for (const x of s.sessions) {
      out.push(
        `  ${pad(x.pid, 8)}${pad(x.mode, 7)}${pad(x.gpu ? "open" : "none", 6)}${pad(x.hwaccel, 8)}${pad(x.vcodec, 11)}${pad(x.target + (x.kbps ? ` @${x.kbps}k` : ""), 15)}${rpad(x.cpu.toFixed(0), 6)}${rpad(x.threads, 4)}${rpad(mb(x.readBps), 11)}${rpad(mb(x.writeBps), 11)}  ${x.file}`,
      );
    }
  }
  out.push("");
  out.push("  also busy on this box");
  if (s.others.length === 0) out.push("    nothing over 5% cpu");
  for (const o of s.others)
    out.push(`    ${pad(o.pid, 8)}${pad(o.comm, 18)}${pad(o.where, 10)}${rpad(o.cpu.toFixed(0) + "%", 6)}${rpad(mb(o.readBps), 11)}`);
  return out;
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  yeet.exit();
});

if (typeof tty === "undefined") {
  // pipe mode: one snapshot per tick
  let seen = 0;
  setInterval(() => {
    const s = state.get();
    if (s.tick === seen) return;
    seen = s.tick;
    console.log(lines(s).join("\n") + "\n");
  }, INTERVAL);
} else {
  const DIM = "#64748b";
  const FG = "#e2e8f0";
  const ACCENT = "#22d3ee";
  const MAGENTA = "#e879f9";
  const OK = "#4ade80";
  const WARN = "#fbbf24";
  const BAD = "#f87171";
  const INK = "#0b1020";
  const BLOCKS = "▁▂▃▄▅▆▇█";

  const clock = signal("");
  setInterval(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    clock.set(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  }, 1000);

  const spark = (xs, max) =>
    xs.map((v) => BLOCKS[Math.max(0, Math.min(7, Math.round((v / max) * 7)))]).join("");
  const modeFg = (m) => (m === "hw" ? OK : m === "mixed" ? WARN : BAD);
  const modeWord = (m) => (m === "hw" ? " HW " : m === "mixed" ? " MIXED " : " SW ");
  const modeSays = (m) =>
    m === "hw" ? "gpu decode + gpu encode"
    : m === "mixed" ? "cpu decode + gpu encode"
    : "cpu decode + cpu encode";
  const badge = (fg, t) => <Text bold fg={INK} bg={fg}>{t}</Text>;
  const Gauge = ({ pct, width = 12 }) => {
    const max = CORES.get() * 100;
    const frac = Math.max(0, Math.min(1, pct / max));
    const n = Math.round(frac * width);
    const fg = frac > 0.75 ? BAD : frac > 0.4 ? WARN : OK;
    return (
      <Text>
        <Text fg={fg}>{"█".repeat(n)}</Text>
        <Text fg={DIM}>{"░".repeat(width - n)}</Text>
        <Text bold fg={fg}>{" " + String(Math.round(pct)).padStart(4) + "%"}</Text>
      </Text>
    );
  };
  const k = (t) => <Text fg={DIM}>{t}</Text>;
  const v = (t, fg = FG) => <Text fg={fg}>{t}</Text>;
  const frame = { line: "round", fg: DIM };

  const Session = ({ x }) => (
    <Box padding={[0, 0, 0, 0]}>
      <Box direction="row">
        <Box width="fit">
          <Text>
            <Text fg={ACCENT}>{"▶ "}</Text>
            <Text bold fg={FG}>{x.file}</Text>
            {k("   pid ")}{v(String(x.pid))}
            {k("  thr ")}{v(String(x.threads))}
          </Text>
        </Box>
      </Box>
      <Box direction="row">
        <Box width="fit">
          <Text>
            {"  "}
            {badge(modeFg(x.mode), modeWord(x.mode))}
            <Text fg={modeFg(x.mode)}>{" " + modeSays(x.mode)}</Text>
            {k("   dri ")}
            <Text bold fg={x.gpu ? OK : BAD}>{x.gpu ? "open" : "none"}</Text>
            {k("   ")}{v(x.hwaccel, MAGENTA)}
            {k(" → ")}{v(x.vcodec, MAGENTA)}
            {k("   ")}{v(x.target + (x.kbps ? ` @${(x.kbps / 1000).toFixed(1)}M` : ""))}
          </Text>
        </Box>
      </Box>
      <Box direction="row">
        <Box width="fit">
          <Text>
            {k("  cpu ")}
            <Gauge pct={x.cpu} />
            <Text fg={modeFg(x.mode)}>{"  " + spark(cpuHist.get(x.pid) ?? [], CORES.get() * 100)}</Text>
            {k("   r ")}{v(mb(x.readBps))}
            {k("  w ")}{v(mb(x.writeBps))}
          </Text>
        </Box>
      </Box>
    </Box>
  );

  const Other = ({ o }) => (
    <Box direction="row">
      <Box width="8"><Text fg={DIM}>{String(o.pid)}</Text></Box>
      <Box width="20" break="none" overflow="ellipsis"><Text fg={FG}>{o.comm}</Text></Box>
      <Box width="11"><Text fg={o.where === "host" ? DIM : ACCENT}>{o.where}</Text></Box>
      <Box width="20"><Gauge pct={o.cpu} width={10} /></Box>
      <Box width="12"><Text fg={DIM}>{mb(o.readBps)}</Text></Box>
    </Box>
  );

  mount(() => (
    <Box>
      <Box direction="row" border={frame} padding={[0, 1]}>
        <Box width="1fr">
          <Text>
            {badge(ACCENT, " jellytop ")}
            {k("  the kernel's view of ")}{v(CONTAINER, ACCENT)}
            {k("  ·  ")}{v(() => String(CORES.get()))}{k(" cores")}
          </Text>
        </Box>
        <Box width="fit">
          <Text>
            {k("pkg ")}
            {() => {
              const t = state.get().temp;
              const fg = t == null ? DIM : t > 85 ? BAD : t > 70 ? WARN : OK;
              return <Text><Text bold fg={fg}>{t == null ? "?" : `${t.toFixed(0)}°C`}</Text><Text fg={fg}>{" " + spark(tempHist, 100)}</Text></Text>;
            }}
            {k("   ")}{v(() => clock.get(), DIM)}
          </Text>
        </Box>
      </Box>

      <Box direction="row" border={frame} padding={[0, 1]}>
        <Box width="1fr">
          {() => {
            const b = box.get();
            const swapBad = (b.swapUsed ?? 0) > 256 * 1048576;
            const memFrac = b.memTotal ? b.memAvail / b.memTotal : 1;
            // A low clock on a governor is normal; a low clock while hot with a transcode running is a throttle.
            const t = state.get().temp ?? 0;
            const slow = b.ghz != null && b.ghzMax && b.ghz < b.ghzMax * 0.5 && t > 85 && state.get().sessions.length > 0;
            return (
              <Text>
                {k("load ")}{v(b.load ? `${b.load.one.toFixed(1)} ${b.load.five.toFixed(1)} ${b.load.fifteen.toFixed(1)}` : "?", b.load && b.load.one > CORES.get() ? WARN : FG)}
                {k("   mem ")}{v(b.memAvail != null ? `${gb(b.memAvail)} free` : "?", memFrac < 0.1 ? BAD : FG)}
                {k("   swap ")}{v(b.swapUsed != null ? `${gb(b.swapUsed)} used` : "?", swapBad ? WARN : FG)}
                {k("   cpu ")}{v(b.ghz != null ? `${b.ghz.toFixed(1)}/${b.ghzMax.toFixed(1)} GHz` : "?", slow ? WARN : FG)}
                {slow ? <Text fg={WARN}>{" throttled?"}</Text> : ""}
                {k("   net ")}{v(b.iface ? `↓${mb(b.rxBps)} ↑${mb(b.txBps)}` : "?", ACCENT)}{k(b.iface ? ` ${b.iface}` : "")}
              </Text>
            );
          }}
        </Box>
      </Box>

      {() => {
        const bad = state.get().sessions.filter((x) => x.mode !== "hw");
        if (bad.length === 0) return [];
        const worst = bad.find((x) => x.mode === "sw") ?? bad[0];
        const fg = modeFg(worst.mode);
        return (
          <Box direction="row" padding={[0, 1]} bg={fg}>
            <Text bold fg={INK}>
              {worst.mode === "sw"
                ? `⚠  SOFTWARE TRANSCODE  pid ${worst.pid} is on the CPU, the GPU is idle for this stream`
                : `⚠  PARTIAL HARDWARE  pid ${worst.pid} decodes on the CPU, only the encode is on the GPU`}
            </Text>
          </Box>
        );
      }}

      <Box border={frame} padding={[0, 1]}>
        <Text>
          <Text bold fg={FG}>transcodes</Text>
          {k("  ")}
          {v(() => String(state.get().sessions.length), ACCENT)}
          {k("  ffmpeg processes inside the container, read from /proc")}
        </Text>
        {() => {
          const s = state.get().sessions;
          if (s.length === 0)
            return <Box><Text fg={DIM}>{"  ○ none    direct play, or nobody is watching"}</Text></Box>;
          return s.map((x) => <Session x={x} />);
        }}
      </Box>

      <Box border={frame} padding={[0, 1]}>
        <Text>
          <Text bold fg={FG}>also busy on this box</Text>
          {k("  anything over 5% cpu that is not a transcode")}
        </Text>
        {() => {
          const o = state.get().others;
          if (o.length === 0) return <Box><Text fg={DIM}>{"  ○ quiet"}</Text></Box>;
          return o.map((x) => <Other o={x} />);
        }}
      </Box>
    </Box>
  ));
}
