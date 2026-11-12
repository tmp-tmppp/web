import { DepositForm } from "./DepositForm";
import { WithdrawForm } from "./WithdrawForm";

/** Deposit and withdraw credits. 1 credit = 1 EUR cent, and every amount is shown in both. */
export function WalletPage() {
  return (
    <section>
      <h1>Wallet</h1>
      <p>Credits are the money of the markets: 1 credit is 1 euro cent, so 100 credits are EUR 1.00.</p>
      <div className="two-columns">
        <DepositForm />
        <WithdrawForm />
      </div>
    </section>
  );
}
