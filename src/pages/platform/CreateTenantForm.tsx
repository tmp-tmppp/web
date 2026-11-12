import { useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { createTenant, SLUG_PATTERN, TENANT_NAME_MAX } from "../../api/tenants";
import type { CreateTenantResponse } from "../../api/tenants";
import { Field } from "../../components/Field";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";

interface Errors {
  name?: string;
  slug?: string;
}

function validate(name: string, slug: string): Errors {
  const errors: Errors = {};
  if (name.trim() === "" || name.trim().length > TENANT_NAME_MAX) errors.name = `Enter a name of 1 to ${TENANT_NAME_MAX} characters.`;
  if (!SLUG_PATTERN.test(slug)) errors.slug = "Use 3 to 40 lowercase letters, digits and dashes, with no dash at the start or the end.";
  return errors;
}

/** Platform admin: creates a tenant (POST /v1/tenants); the answer carries the first admin's invite code. */
export function CreateTenantForm({ onCreated }: { onCreated: (created: CreateTenantResponse) => void }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const found = validate(name, slug);
    setErrors(found);
    if (found.name || found.slug) return;
    setBusy(true);
    try {
      const created = await createTenant(api, { name: name.trim(), slug });
      setName("");
      setSlug("");
      onCreated(created);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="create-tenant-title" aria-busy={busy}>
      <h2 id="create-tenant-title">Create a tenant</h2>
      <Field id="tenant-name" label="Name" error={errors.name ?? null}>
        {(control) => <input {...control} type="text" value={name} maxLength={TENANT_NAME_MAX} onChange={(event) => setName(event.target.value)} required />}
      </Field>
      <Field id="tenant-slug" label="Slug" hint="Lowercase letters, digits and dashes, 3 to 40 characters." error={errors.slug ?? null}>
        {(control) => (
          <input {...control} type="text" value={slug} maxLength={40} onChange={(event) => setSlug(event.target.value)} autoCapitalize="off" spellCheck={false} required />
        )}
      </Field>
      <button type="submit" className="button" disabled={busy}>
        Create the tenant
      </button>
      {busy ? <StatusMessage>Creating the tenant...</StatusMessage> : null}
      {failure ? <ProblemDisplay error={failure} heading="The tenant could not be created" /> : null}
    </form>
  );
}
