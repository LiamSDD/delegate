import { MissionCatalogue } from "@/components/mission-catalogue";
import { type ExampleTarget, MissionInput } from "@/components/mission-input";
import { SectionHeading } from "@/components/section-heading";
import { SystemStatus } from "@/components/system-status";
import { TrustStrip } from "@/components/trust-strip";
import { loadKeylessChain } from "@/lib/model-chain-file";

const EXAMPLES: readonly ExampleTarget[] = [
  { label: "stripe.com", value: "https://stripe.com" },
  { label: "linear.app", value: "https://linear.app" },
  { label: "datadoghq.com", value: "https://www.datadoghq.com" },
  { label: "github.com/vercel/next.js", value: "https://github.com/vercel/next.js" },
  {
    label: "Map where our docs contradict the pricing page",
    value: "Map where our public docs contradict the pricing page",
  },
];

export default function HomePage() {
  const chain = loadKeylessChain();
  return (
    <div className="mx-auto flex max-w-content flex-col px-6">
      <section
        aria-labelledby="hero-title"
        className="flex flex-col gap-10 pt-16 pb-20 md:pt-24 md:pb-28"
      >
        <div className="flex max-w-3xl flex-col gap-5">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            Preview <span aria-hidden="true">·</span> runtime arrives in M1
          </p>
          <h1
            id="hero-title"
            className="font-serif text-display-md tracking-display text-balance sm:text-display-lg"
          >
            Give it a goal.
            <br />
            Get back verified work.
          </h1>
          <p className="max-w-xl text-md text-text-muted text-pretty">
            Delegate turns a company&apos;s goals into finished, cited work, and checks every action
            against policy before it runs.
          </p>
        </div>
        <div className="flex max-w-3xl flex-col gap-6">
          <MissionInput examples={EXAMPLES} />
          <SystemStatus summary={chain} />
        </div>
      </section>

      <section
        aria-labelledby="missions-title"
        className="flex flex-col gap-10 border-t border-border py-20"
      >
        <SectionHeading
          index="01"
          label="Missions"
          title="What you can delegate"
          id="missions-title"
        >
          Each mission is one folder: input schema, allowed tools, policies, deliverable schema and
          an eval dataset. Nothing here runs yet; every row says when it arrives.
        </SectionHeading>
        <MissionCatalogue />
      </section>

      <section
        aria-labelledby="trust-title"
        className="flex flex-col gap-10 border-t border-border py-20"
      >
        <SectionHeading index="02" label="Trust" title="How it stays trustworthy" id="trust-title">
          Controls live in the runtime, not in prompts. Each claim links to the design it is built
          from.
        </SectionHeading>
        <TrustStrip />
      </section>
    </div>
  );
}
