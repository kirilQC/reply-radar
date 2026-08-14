// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The one breadcrumb every page uses.
 *
 * Each page used to hand-roll its own trail, so the separator was a chevron here, a slash
 * there and a "›" glued to the front of the label somewhere else, and the root was sometimes
 * a link and sometimes dead text. Passing the trail in keeps that decision in one file.
 *
 * "Reply Radar" is always the root and always goes home, so callers pass only what comes
 * after it. The last step is the page you are on and is never a link.
 */
export type CrumbStep = {
  label: string;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
};

export default function Crumb({ trail }: { trail: CrumbStep[] }) {
  const steps: CrumbStep[] = [{ label: "Reply Radar", href: "/" }, ...trail];
  return (
    <nav className="crumb" aria-label="Breadcrumb">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <span className="crumb-step" key={`${step.label}-${index}`}>
            {index > 0 && (
              <span className="crumb-chevron" aria-hidden="true">
                ›
              </span>
            )}
            {last || (!step.href && !step.onClick) ? (
              <span className={last ? "crumb-current" : "crumb-text"}>
                {step.label}
              </span>
            ) : (
              <a className="crumb-link" href={step.href} onClick={step.onClick}>
                {step.label}
              </a>
            )}
          </span>
        );
      })}
    </nav>
  );
}
