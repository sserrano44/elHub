import { BorrowWithdrawForm } from "../../components/borrow-withdraw-form";

export default function BorrowPage() {
  return (
    <section className="stack">
      <article className="card">
        <h2>Borrow To Worldchain</h2>
        <p className="muted">Lifecycle: pending lock -&gt; locked -&gt; filled -&gt; awaiting settlement -&gt; settled, or locked -&gt; expired_unwound when the fill window expires.</p>
      </article>
      <BorrowWithdrawForm mode="borrow" />
    </section>
  );
}
