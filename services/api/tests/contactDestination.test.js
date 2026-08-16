/**
 * Where a contact-form message actually goes.
 *
 * `ADMIN_EMAIL` decides whether a human is told about a submission, and it is
 * declared in three files that cannot import each other — the Terraform variable
 * Cloud Run reads, and the two `.env.example` templates a self-hosted or local
 * deployment is copied from. Nothing connected them, so changing the destination
 * meant remembering all three, and getting it wrong is silent: the form keeps
 * answering "we've got your message" while the notification goes to an address
 * nobody reads, or to nowhere at all.
 *
 * Read as text rather than imported, the same way `sharedConstants.test.js` and
 * `familyBrandColors.test.js` bridge files that live in different module systems.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** `ADMIN_EMAIL=someone@example.com` → `someone@example.com` */
const fromEnvFile = (file) =>
  /^\s*ADMIN_EMAIL\s*=\s*(\S+)\s*$/m.exec(read(file))?.[1];

/** The `admin_email` variable's default in variables.tf. */
const fromTerraform = () => {
  const tf = read('infrastructure/gcp/variables.tf');
  const block = tf.slice(tf.indexOf('variable "admin_email"'));
  return /default\s*=\s*"([^"]+)"/.exec(block)?.[1];
};

/** Any `admin_email = "..."` an environment sets, which would win over the default. */
const overrideIn = (tfvars) => {
  const file = path.join(REPO, tfvars);
  if (!fs.existsSync(file)) return null;
  return /^\s*admin_email\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null;
};

describe('the contact form has one destination', () => {
  it('names the same address everywhere it is declared', () => {
    const declared = {
      terraform: fromTerraform(),
      apiEnvExample: fromEnvFile('services/api/.env.example'),
      singleHostEnvExample: fromEnvFile('deploy/single-host/.env.example'),
    };

    // Each file has to declare one at all — a regex that stopped matching would
    // otherwise make the agreement below pass vacuously on a set of undefineds.
    for (const [where, value] of Object.entries(declared)) {
      expect(`${where} declares: ${value}`).toMatch(/@/);
    }

    // Compared as the whole object so a failure names which file disagrees,
    // rather than reporting that a set had two members.
    const [first] = Object.values(declared);
    expect(declared).toEqual({
      terraform: first,
      apiEnvExample: first,
      singleHostEnvExample: first,
    });
  });

  /**
   * Terraform's default applies only where an environment does not override it,
   * so an override is the one way the deployed value can differ from the one
   * every other file advertises. Either it matches, or it is a deliberate
   * different mailbox — and this is where that decision gets written down.
   */
  it('is not quietly overridden by an environment', () => {
    const base = fromTerraform();
    for (const tfvars of ['infrastructure/gcp/envs/dev.tfvars', 'infrastructure/gcp/envs/prod.tfvars']) {
      const override = overrideIn(tfvars);
      if (override !== null) expect(`${tfvars} → ${override}`).toBe(`${tfvars} → ${base}`);
    }
  });

  it('is a deliverable address rather than a placeholder', () => {
    // The shape `configured()` in env.js strips: a template left unfilled reads
    // as configured to every `if (value)` check and delivers to nothing.
    const address = fromTerraform();
    expect(address).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/);
    expect(address).not.toMatch(/REPLACE_WITH|example\.com|your[-_]/i);
  });
});
