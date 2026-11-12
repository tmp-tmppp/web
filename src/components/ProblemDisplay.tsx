import { ApiError } from "../api/errors";
import { describeWait } from "../lib/format";

interface ProblemDisplayProps {
  /** What went wrong: an ApiError is shown with its title and detail, anything else with a general message. */
  error: unknown;
  /** Replaces the title, for example "The member could not be changed". */
  heading?: string;
}

/**
 * Shows a failed request as a readable message: the problem's title and detail, the invalid fields, how long to wait
 * when the server sent Retry-After, and the correlation id to quote when asking for help. Never a stack or raw JSON.
 */
export function ProblemDisplay({ error, heading }: ProblemDisplayProps) {
  if (!(error instanceof ApiError)) {
    return (
      <div className="problem" role="alert">
        <p className="problem-title">{heading ?? "Something went wrong"}</p>
        <p>The page could not finish what you asked for. Try again in a moment.</p>
      </div>
    );
  }
  return (
    <div className="problem" role="alert">
      <p className="problem-title">{heading ?? error.title}</p>
      {heading && heading !== error.title ? <p>{error.title}</p> : null}
      {error.detail ? <p>{error.detail}</p> : null}
      {error.fieldErrors.length > 0 ? (
        <ul className="problem-fields">
          {error.fieldErrors.map((item, index) => (
            <li key={`${item.field}-${index}`}>
              <strong>{item.field}</strong>: {item.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error.retryAfterSeconds !== null ? <p>Try again in {describeWait(error.retryAfterSeconds)}.</p> : null}
      {error.correlationId ? <p className="problem-reference">Reference: {error.correlationId}</p> : null}
    </div>
  );
}
