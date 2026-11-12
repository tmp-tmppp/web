import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { lookupSharedMarket, SHARE_PATH, SHARE_TOKEN_PATTERN } from "../../api/markets";
import type { Lookup } from "../../api/markets";
import { joinByShareLink, listMyOrganizations } from "../../api/tenants";
import { useAuth } from "../../auth/AuthContext";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useOrganizations } from "../../organizations/OrganizationsContext";
import { PENDING_MAX_WAITS, PENDING_WAIT_MS } from "../use-me";
import { CreditsHint, MarketSummary, readyPath } from "./parts";

/** The token of the link: what follows "#" in the address, when it has the shape of a token. The fragment never reaches a server. */
function tokenFromHash(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return SHARE_TOKEN_PATTERN.test(value) ? value : null;
}

type Phase = { kind: "loading" } | { kind: "missing" } | { kind: "found"; lookup: Lookup } | { kind: "problem"; error: unknown };

type Join = { step: "idle" } | { step: "joining" } | { step: "waiting" } | { step: "slow"; alias: string; marketId: string } | { step: "failed"; error: unknown };

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * The landing page of a share link (/share#<token>), open without a session. The token is read from the address once,
 * kept in this component's state and removed from the address bar, then posted to the lookup in a request body (never in
 * an address). What the page offers follows what the service says the caller may do (`next`):
 *  - sign_in: show the market (a link for everyone can be seen without signing in) and offer the sign-in, which comes back here;
 *  - join: sign in is done, the caller is no member: join the organization (POST /v1/share-joins), wait until the identity
 *    provider holds the membership, sign in again for that organization and open the market;
 *  - switch_organization / a 403: the link is not for this caller; the page names the organization and, for a member of it
 *    in another sign-in, offers the switch;
 *  - trade: a member, the market is open: open it.
 */
export function SharePage() {
  useDocumentTitle("Shared market");
  const api = useApi();
  const { user, login } = useAuth();
  const { organizations, reload } = useOrganizations();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => tokenFromHash(location.hash));
  const [phase, setPhase] = useState<Phase>(() => (token ? { kind: "loading" } : { kind: "missing" }));
  const [join, setJoin] = useState<Join>({ step: "idle" });
  const [round, setRound] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The fragment holds the secret: after it was read, the address bar shows the page only (a reload asks for the link again).
  useEffect(() => {
    if (location.hash !== "") void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    lookupSharedMarket(api, token, controller.signal).then(
      (lookup) => setPhase({ kind: "found", lookup }),
      (error: unknown) => {
        if (!controller.signal.aborted) setPhase({ kind: "problem", error });
      },
    );
    return () => controller.abort();
  }, [api, token, round]);

  function retry() {
    setPhase({ kind: "loading" });
    setRound((value) => value + 1);
  }

  /** The way back to this page after a sign-in: the token in the fragment, carried through the sign-in state of this browser only. */
  const here = token ? `${SHARE_PATH}#${token}` : SHARE_PATH;

  async function joinAndSwitch() {
    if (!token) return;
    setJoin({ step: "joining" });
    try {
      const joined = await joinByShareLink(api, token);
      for (let waits = 0; ; waits += 1) {
        const page = await listMyOrganizations(api, null);
        if (!alive.current) return;
        if (!page.identityPending) break;
        if (waits >= PENDING_MAX_WAITS) {
          setJoin({ step: "slow", alias: joined.alias, marketId: joined.marketId });
          return;
        }
        setJoin({ step: "waiting" });
        await sleep(PENDING_WAIT_MS);
        if (!alive.current) return;
      }
      reload();
      await continueTo(joined.alias, joined.marketId);
    } catch (error) {
      if (alive.current) setJoin({ step: "failed", error });
    }
  }

  /** Into the organization of the market: straight on when the token already is for it, else a new sign-in for it. */
  async function continueTo(alias: string, marketId: string) {
    const target = readyPath(marketId);
    if (user?.tenantId === alias) void navigate(target);
    else await login(target, { organization: alias });
  }

  if (phase.kind === "loading") {
    return (
      <section aria-busy="true">
        <h1>A shared market</h1>
        <StatusMessage>Opening the link...</StatusMessage>
      </section>
    );
  }
  if (phase.kind === "missing") {
    return (
      <section>
        <h1>A shared market</h1>
        <p role="alert">This page needs a share link, and the address has none that is complete.</p>
        <p>Open the link as you received it. If it was cut off, ask the person who sent it to send it again.</p>
        <HomeLink signedIn={user !== null} />
      </section>
    );
  }

  if (phase.kind === "problem") {
    const error = phase.error;
    if (error instanceof ApiError && error.status === 404) {
      return (
        <section>
          <h1>This link does not work</h1>
          <p role="alert">The link is not valid. It may have ended, been revoked or been copied incompletely.</p>
          <p>Ask the person who sent it for a new one.</p>
          <HomeLink signedIn={user !== null} />
        </section>
      );
    }
    if (error instanceof ApiError && error.status === 403) {
      const name = error.organizationName;
      const mine = name ? organizations.filter((organization) => organization.name === name) : [];
      const target = mine[0];
      return (
        <section>
          <h1>This link is not for you</h1>
          <p role="alert">{name ? `The link leads to a market of ${name}, and it is not open to you.` : "The link leads to a market that is not open to you."}</p>
          {error.next.includes("switch_organization") && target ? (
            <>
              <p>
                You belong to {target.name}, but you are signed in for another organization. Switch, and the link opens.
              </p>
              <button type="button" className="button" onClick={() => void login(here, { organization: target.alias })}>
                Switch to {target.name}
              </button>
            </>
          ) : null}
          {error.next.includes("switch_organization") && !target ? (
            <p>You are signed in for another organization. If you belong to {name ?? "this one"}, switch to it with the menu at the top; otherwise ask its admin for an invite.</p>
          ) : null}
          {error.next.includes("sign_in") ? (
            <>
              <p>Sign in, and the link tells whether it is meant for you.</p>
              <button type="button" className="button" onClick={() => void login(here)}>
                Sign in
              </button>
            </>
          ) : null}
          {!error.next.includes("switch_organization") && !error.next.includes("sign_in") ? (
            <p>The link is for other people. If it was meant for you, check that you are signed in with the e-mail address it was sent to and that the identity provider has verified it, or ask for a new link.</p>
          ) : null}
          <HomeLink signedIn={user !== null} />
        </section>
      );
    }
    return (
      <section>
        <h1>A shared market</h1>
        <ProblemDisplay error={error} heading="The link could not be opened" />
        <button type="button" className="button" onClick={retry}>
          Try again
        </button>
      </section>
    );
  }

  const { lookup } = phase;
  const name = lookup.organization.name ?? "the organization";
  const can = (action: Lookup["next"][number]) => lookup.next.includes(action);
  return (
    <section>
      <h1>A shared market</h1>
      <MarketSummary lookup={lookup} />
      {can("trade") ? (
        <>
          <p>You belong to {name}. You can trade here with the credits of that organization.</p>
          <div className="actions">
            <Link className="button" to={`/markets/${lookup.market.id}`}>
              Open the market
            </Link>
          </div>
          <CreditsHint organization={name} />
        </>
      ) : null}
      {can("sign_in") ? (
        <>
          <p>Sign in to trade. If you do not belong to {name} yet, the next step lets you join it.</p>
          <div className="actions">
            <button type="button" className="button" onClick={() => void login(here)}>
              Sign in to trade
            </button>
          </div>
          <CreditsHint organization={name} />
        </>
      ) : null}
      {can("join") ? (
        <>
          <p>This link lets you join {name}. You become a trader there, and the market opens after you have joined.</p>
          <div className="actions">
            <button type="button" className="button" disabled={join.step === "joining" || join.step === "waiting"} onClick={() => void joinAndSwitch()}>
              Join {name} and open the market
            </button>
          </div>
          <CreditsHint organization={name} />
        </>
      ) : null}
      {can("switch_organization") && !can("join") && !can("trade") ? (
        <p>You are signed in for another organization. Switch to {name} with the menu at the top to trade here.</p>
      ) : null}
      {join.step === "joining" ? <StatusMessage>Joining {name}...</StatusMessage> : null}
      {join.step === "waiting" ? <StatusMessage>You joined {name}. Waiting for the identity provider to catch up; there is nothing to do.</StatusMessage> : null}
      {join.step === "slow" ? (
        <div className="notice-box" role="status">
          <p>You joined {name}, but the identity provider has not caught up yet. This can take a minute.</p>
          <div className="actions">
            <button type="button" className="button" onClick={() => void continueTo(join.alias, join.marketId).catch((error: unknown) => setJoin({ step: "failed", error }))}>
              Continue to {name}
            </button>
          </div>
        </div>
      ) : null}
      {join.step === "failed" ? <ProblemDisplay error={join.error} heading="You could not join" /> : null}
    </section>
  );
}

function HomeLink({ signedIn }: { signedIn: boolean }) {
  return signedIn ? (
    <p>
      <Link to="/">Back to the start page</Link>
    </p>
  ) : null;
}
