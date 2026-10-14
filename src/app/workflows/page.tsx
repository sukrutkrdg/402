import { getService } from "@/lib/services";
import { TEMPLATES, MAX_STEPS } from "@/lib/workflows";
import WorkflowsClient from "./WorkflowsClient";

export const metadata = {
  title: "Workflows — x402 Bazaar",
  description: "Run up to five paid checks in one request on a prepaid credit token. Each step is debited like a direct call; a STOP verdict ends the run before later steps are charged.",
};

export default function WorkflowsPage() {
  const templates = TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    steps: t.steps.map((s) => ({ service: s.service, name: getService(s.service)?.name ?? s.service, params: s.params ?? {} })),
  }));
  return <WorkflowsClient templates={templates} maxSteps={MAX_STEPS} />;
}
