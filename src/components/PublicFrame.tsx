import type { ReactNode } from "react";

/** The frame around pages shown without a session: the brand and the page, no navigation. */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <span className="brand">Chance</span>
      </header>
      <main id="main" className="content content-narrow">
        {children}
      </main>
    </>
  );
}
