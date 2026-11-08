import { createApp } from "./app.js";
import type { CoverageAdapter } from "./coverage/adapter.js";
import { ClaudeCoverageAdapter } from "./coverage/claude.js";
import { MockCoverageAdapter } from "./coverage/mock.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const provider = process.env.COVERAGE_PROVIDER ?? "mock";
const model = process.env.COVERAGE_MODEL ?? "claude-opus-5-5";

let adapter: CoverageAdapter;
if (provider === "claude") {
  adapter = new ClaudeCoverageAdapter(model);
} else if (provider === "mock") {
  adapter = new MockCoverageAdapter();
} else {
  throw new Error(`Unknown COVERAGE_PROVIDER "${provider}" (expected claude or mock)`);
}

const { server } = createApp({ adapter: () => adapter, allowedOrigin: process.env.ALLOWED_ORIGIN });

server.listen(port, host, () => {
  const label = adapter.simulated ? "mock (SIMULATED coverage)" : `${adapter.name} (${model})`;
  console.log(`Thread backend listening on http://${host}:${port} — coverage: ${label}`);
  if (process.env.DAYTONA_SANDBOX_ID) {
    console.log(`Daytona preview (expected): https://${port}-${process.env.DAYTONA_SANDBOX_ID}.proxy.daytona.works`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
