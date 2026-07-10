// Single-sourced connect-source honesty notice (§3/D21/D31). This copy is
// honesty-load-bearing: while the number's source is unconnected it must state
// that the report grades activity, not outcomes, and must never claim the metric
// moved. It renders on the home page and the CMO report; keeping it in one place
// stops the two surfaces from drifting. Static, non-interactive (the CTA is a
// disabled button); rendered as React-escaped JSX children — no props needed.
export function ConnectSourceNotice() {
  return (
    <>
      <p>
        Your number&rsquo;s source is not connected yet, so this report grades activity, not outcomes —
        it will never claim your metric moved until a real source is connected.
      </p>
      <button type="button" disabled>Connect your number&rsquo;s source</button>
    </>
  );
}
