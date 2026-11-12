interface OwnedElsewhereProps {
  title: string;
  /** The services the page talks to, in words, for example "markets and market-data". */
  services: string;
}

/**
 * PLACEHOLDER for the pages of the markets, trading and market-data services. Another member of the team builds them
 * (plan Q-16). The route, the menu entry and the access rule are in place in routes/route-table.tsx; the page replaces
 * the element of its route there, and nothing else in the shell needs to change.
 */
export function OwnedElsewherePage({ title, services }: OwnedElsewhereProps) {
  return (
    <section>
      <h1>{title}</h1>
      <div className="placeholder" data-placeholder="markets-trading">
        <p>
          <strong>Placeholder.</strong> This page belongs to the {services} service and is built by its owner.
        </p>
        <p>The address, the menu entry and the access rule already exist; the page takes the place of this text.</p>
      </div>
    </section>
  );
}
