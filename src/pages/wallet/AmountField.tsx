import { AMOUNT_MAX, AMOUNT_MIN } from "../../api/payments";
import { Field } from "../../components/Field";
import { formatAmount } from "../../lib/format";
import { wholeNumberInRange } from "../../lib/numbers";

/** The amount of a deposit or withdrawal in credits, or null when the text is not a whole number from 1 to 1,000,000. */
export function parseAmount(text: string): number | null {
  return wholeNumberInRange(text, AMOUNT_MIN, AMOUNT_MAX);
}

export const AMOUNT_RULE = `Enter a whole number of credits from ${AMOUNT_MIN} to ${AMOUNT_MAX.toLocaleString("en-US")}.`;

interface AmountFieldProps {
  id: string;
  label: string;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}

/** An amount in credits; under it the same amount in euros (1 credit = 1 EUR cent), so nobody pays 100 times too much. */
export function AmountField({ id, label, value, error, disabled, onChange }: AmountFieldProps) {
  const amount = parseAmount(value);
  const hint = amount === null ? `${AMOUNT_RULE} 1 credit = 1 EUR cent.` : `That is ${formatAmount(amount)}. 1 credit = 1 EUR cent.`;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(control) => (
        <input {...control} type="text" inputMode="numeric" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}
