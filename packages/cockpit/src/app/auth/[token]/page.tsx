import { redeemLogin } from "../../actions-auth";

export const dynamic = "force-dynamic";

export default async function RedeemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main>
      <h2>Sign in</h2>
      <p>Press the button to finish signing in. This link works once and expires quickly.</p>
      <form action={redeemLogin}>
        <input type="hidden" name="token" value={token} />
        <button type="submit">Sign in to the cockpit</button>
      </form>
    </main>
  );
}
