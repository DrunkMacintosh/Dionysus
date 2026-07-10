import { requireSession } from "../../lib/auth";
import { getCmoReport, isRenderableHttpUrl } from "../../lib/review";
import { ConnectSourceNotice } from "../connect-source-notice";

export const dynamic = "force-dynamic";

// Weekly CMO Report (§3/D21/D31). Three honest sections:
//   1. What ran            — verified sends this week (or nothing did).
//   2. What moved the number — HONEST: analytics is not connected at 4f, so this
//      leads with the measurement gap (the grader's headline) + the connect CTA,
//      keyed on `!report.analyticsConnected`. It never shows a fabricated
//      metric movement or percentage.
//   3. What changes next week — the grader's recommendation + the week's counts.
// All model/founder text is rendered as React-escaped JSX children — no
// dangerouslySetInnerHTML; postedUrl becomes an <a href> only via isRenderableHttpUrl.
export default async function ReportPage() {
  const session = await requireSession();
  const report = await getCmoReport({ businessId: session.businessId });
  const { weekOf, whatRan, inFlight, proposedPending, radarNoticed, verdict, analyticsConnected } = report;

  return (
    <main>
      <header style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Weekly CMO Report — week of {weekOf}</h2>
        <span
          style={{
            display: "inline-block",
            padding: "2px 10px",
            borderRadius: 999,
            border: "1px solid #ccc",
            background: "#f3f3f3",
            fontSize: 13,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {verdict.state}
        </span>
      </header>

      <section style={{ marginBottom: 24 }}>
        <h3>What ran</h3>
        {whatRan.length === 0 ? (
          <p>Nothing went live this week.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {whatRan.map((w) => (
              <li key={w.actionId} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <strong>{w.channel ?? "(no channel)"}</strong>
                {" · "}
                {w.title ?? "(untitled)"}
                {" · "}
                {w.postedUrl && isRenderableHttpUrl(w.postedUrl) ? (
                  <a href={w.postedUrl} target="_blank" rel="noopener noreferrer">verified live</a>
                ) : (
                  <span>{w.postedUrl ? "not a linkable URL" : "(no URL)"}</span>
                )}
                <span style={{ color: "#666" }}> · verified {w.verifiedAt.toISOString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>What moved the number</h3>
        {!analyticsConnected ? (
          <div style={{ border: "1px dashed #999", borderRadius: 8, padding: 16, background: "#fafafa" }}>
            <span
              style={{
                display: "inline-block",
                padding: "2px 10px",
                borderRadius: 999,
                background: "#fde68a",
                color: "#663c00",
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 8,
              }}
            >
              Not yet measured
            </span>
            <p style={{ margin: "0 0 12px" }}>{verdict.headline}</p>
            <ConnectSourceNotice />
          </div>
        ) : (
          // Stage-5 measured path: the grader supplies a real, measured sentence.
          <p>{verdict.headline}</p>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>What changes next week</h3>
        <p>{verdict.recommendation}</p>
        <ul>
          <li>{inFlight} in flight</li>
          <li>{proposedPending} drafts awaiting review</li>
          <li>{radarNoticed.length} signals on radar as upcoming proposed work</li>
        </ul>
      </section>
    </main>
  );
}
