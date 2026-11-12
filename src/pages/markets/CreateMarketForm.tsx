import { useId, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { createMarket, LINK_TYPE_LABELS, LINK_TYPES } from "../../api/markets";
import type { CreateMarketRequest, LinkType, Market, WhoMayShare } from "../../api/markets";
import { Field } from "../../components/Field";
import type { FieldError } from "../../api/types";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatAmount } from "../../lib/format";
import { wholeNumberInRange } from "../../lib/numbers";
import { parsePriceCents } from "../../lib/units";

const QUESTION_MIN = 10;
const QUESTION_MAX = 200;
const DESCRIPTION_MAX = 2000;

type FieldName = "question" | "description" | "closeTime" | "startingPrice" | "fundingAmount";
type FieldErrors = Partial<Record<FieldName, string>>;

const WHO_MAY_SHARE: { value: WhoMayShare; label: string }[] = [
  { value: "members", label: "Every member of the organization" },
  { value: "admins", label: "Tenant admins only" },
  { value: "none", label: "Nobody (no share links)" },
];

/** The form field a service's field name belongs to: "closeTime", "/closeTime" and "body.closeTime" all name closeTime. */
function fieldOf(name: string): FieldName | null {
  const first = name.replace(/^(?:body)?[./]/, "").split(/[./[]/)[0];
  const known: FieldName[] = ["question", "description", "closeTime", "startingPrice", "fundingAmount"];
  return known.find((candidate) => candidate === first) ?? null;
}

/** The server's field errors by field, and the error without the fields the form shows by themselves. */
function splitServerError(error: unknown): { fields: FieldErrors; rest: unknown } {
  if (!(error instanceof ApiError) || error.fieldErrors.length === 0) return { fields: {}, rest: error };
  const fields: FieldErrors = {};
  const others: FieldError[] = [];
  for (const item of error.fieldErrors) {
    const field = fieldOf(item.field);
    if (field && !fields[field]) fields[field] = item.message;
    else others.push(item);
  }
  const rest = new ApiError({
    status: error.status,
    type: error.type,
    title: error.title,
    detail: error.detail,
    code: error.code,
    fieldErrors: others,
    retryAfterSeconds: error.retryAfterSeconds,
    correlationId: error.correlationId,
  });
  return { fields, rest };
}

/** Local date and time as the browser field holds it ("2026-12-31T12:00") to the instant the service wants (RFC 3339, with a zone). */
function instantOf(text: string): string | null {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface FormValues {
  question: string;
  description: string;
  closeTime: string;
  price: string;
  funding: string;
  whoMayShare: WhoMayShare;
  linkTypes: LinkType[];
}

/** What the form can check before it sends anything: the request when every field is fine, else the words for each field that is not. */
function validate(values: FormValues, now: number): { request: CreateMarketRequest | null; errors: FieldErrors } {
  const found: FieldErrors = {};
  const trimmed = values.question.trim();
  if (trimmed.length < QUESTION_MIN || trimmed.length > QUESTION_MAX) found.question = `Write the question in ${QUESTION_MIN} to ${QUESTION_MAX} characters.`;
  if (values.description.trim().length > DESCRIPTION_MAX) found.description = `The description may have at most ${DESCRIPTION_MAX.toLocaleString("en-US")} characters.`;
  const instant = values.closeTime === "" ? null : instantOf(values.closeTime);
  if (instant === null) found.closeTime = "Choose the date and time when the market closes.";
  else if (new Date(instant).getTime() <= now) found.closeTime = "The close time must be in the future.";
  const cents = parsePriceCents(values.price);
  if (cents === null) found.startingPrice = "Enter a price from 0.01 to 0.99 with at most two decimals, for example 0.35.";
  const fundingAmount = wholeNumberInRange(values.funding, 1, Number.MAX_SAFE_INTEGER);
  if (fundingAmount === null) found.fundingAmount = "Enter a whole number of credits, at least 1.";
  if (Object.keys(found).length > 0 || instant === null || cents === null || fundingAmount === null) return { request: null, errors: found };
  const sharingChanged = values.whoMayShare !== "members" || values.linkTypes.length !== 1 || values.linkTypes[0] !== "members";
  const request: CreateMarketRequest = {
    question: trimmed,
    ...(values.description.trim() !== "" ? { description: values.description.trim() } : {}),
    closeTime: instant,
    // The service takes the price as a JSON number with two decimals; cents / 100 prints as exactly that.
    startingPrice: cents / 100,
    fundingAmount,
    ...(sharingChanged ? { sharing: { whoMayShare: values.whoMayShare, linkTypes: LINK_TYPES.filter((type) => values.linkTypes.includes(type)) } } : {}),
  };
  return { request, errors: found };
}

interface CreateMarketFormProps {
  /** Called with the draft that was made, so the list can read again. */
  onCreated: (market: Market) => void;
}

/**
 * Tenant admins make a draft market here (UC-10): question, description, close time, the starting YES price and the
 * funding they will pay when they open it. The form checks what it can and names the field in words; the service's own
 * field errors (problem+json `errors`) are shown under the field they name. Opening the draft is a separate step on the
 * market's page, because that is when the creator's credits are taken.
 */
export function CreateMarketForm({ onCreated }: CreateMarketFormProps) {
  const api = useApi();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [closeTime, setCloseTime] = useState("");
  const [price, setPrice] = useState("");
  const [funding, setFunding] = useState("");
  const [whoMayShare, setWhoMayShare] = useState<WhoMayShare>("members");
  const [linkTypes, setLinkTypes] = useState<LinkType[]>(["members"]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Market | null>(null);

  const fundingAmount = wholeNumberInRange(funding, 1, Number.MAX_SAFE_INTEGER);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setCreated(null);
    const { request, errors: found } = validate({ question, description, closeTime, price, funding, whoMayShare, linkTypes }, Date.now());
    setErrors(found);
    if (!request) return;
    setBusy(true);
    try {
      const market = await createMarket(api, request);
      setCreated(market);
      setQuestion("");
      setDescription("");
      setCloseTime("");
      setPrice("");
      setFunding("");
      setWhoMayShare("members");
      setLinkTypes(["members"]);
      setExpanded(false);
      onCreated(market);
    } catch (error) {
      const split = splitServerError(error);
      setErrors(split.fields);
      setFailure(split.rest);
    } finally {
      setBusy(false);
    }
  }

  function toggleLinkType(type: LinkType, on: boolean) {
    setLinkTypes((previous) => (on ? [...previous, type] : previous.filter((entry) => entry !== type)));
  }

  return (
    <div className="create-market">
      <button type="button" className="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide the form" : "Create a market"}
      </button>
      {created ? (
        <p className="success" role="status">
          The draft was created. <Link to={`/markets/${created.id}`}>Go to the market</Link> to open it: opening takes {formatAmount(created.fundingAmount)} from your balance.
        </p>
      ) : null}
      {expanded ? (
        <form id={panelId} className="card" onSubmit={(event) => void submit(event)} noValidate aria-labelledby={`${panelId}-title`} aria-busy={busy}>
          <h2 id={`${panelId}-title`}>New market</h2>
          <p>The market starts as a draft that only tenant admins see. You open it when it is ready.</p>
          <Field id="market-question" label="Question" hint={`A yes or no question, ${QUESTION_MIN} to ${QUESTION_MAX} characters.`} error={errors.question ?? null}>
            {(control) => <input {...control} type="text" autoComplete="off" value={question} disabled={busy} onChange={(event) => setQuestion(event.target.value)} />}
          </Field>
          <Field id="market-description" label="Description (optional)" hint="What counts as YES, and where the answer can be checked." error={errors.description ?? null}>
            {(control) => <textarea {...control} rows={4} value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} />}
          </Field>
          <Field id="market-close-time" label="Closes at" hint="Trading stops then. It must be a few minutes to a year ahead." error={errors.closeTime ?? null}>
            {(control) => <input {...control} type="datetime-local" value={closeTime} disabled={busy} onChange={(event) => setCloseTime(event.target.value)} />}
          </Field>
          <Field id="market-price" label="Starting YES price" hint="From 0.01 to 0.99; NO starts at 1 minus that. 0.35 means the group starts at a 35 % chance of YES." error={errors.startingPrice ?? null}>
            {(control) => <input {...control} type="text" inputMode="decimal" autoComplete="off" value={price} disabled={busy} onChange={(event) => setPrice(event.target.value)} />}
          </Field>
          <Field
            id="market-funding"
            label="Funding, in credits"
            hint={
              fundingAmount === null
                ? "Whole credits, taken from your balance when you open the market. The service sets the limits."
                : `That is ${formatAmount(fundingAmount)}, taken from your balance when you open the market. 1 credit = 1 EUR cent.`
            }
            error={errors.fundingAmount ?? null}
          >
            {(control) => <input {...control} type="text" inputMode="numeric" autoComplete="off" value={funding} disabled={busy} onChange={(event) => setFunding(event.target.value)} />}
          </Field>
          <fieldset disabled={busy}>
            <legend>Sharing (fixed for the life of the market)</legend>
            <Field id="market-who-may-share" label="Who may make share links">
              {(control) => (
                <select {...control} value={whoMayShare} onChange={(event) => setWhoMayShare(event.target.value as WhoMayShare)}>
                  {WHO_MAY_SHARE.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <fieldset>
              <legend>Kinds of link that may be made</legend>
              {LINK_TYPES.map((type) => (
                <div className="choice" key={type}>
                  <label>
                    <input type="checkbox" checked={linkTypes.includes(type)} onChange={(event) => toggleLinkType(type, event.target.checked)} /> {LINK_TYPE_LABELS[type]}
                  </label>
                </div>
              ))}
            </fieldset>
          </fieldset>
          <button type="submit" className="button" disabled={busy}>
            Create the draft
          </button>
          {busy ? <StatusMessage>Creating the market...</StatusMessage> : null}
          {failure ? <ProblemDisplay error={failure} heading="The market was not created" /> : null}
        </form>
      ) : null}
    </div>
  );
}
