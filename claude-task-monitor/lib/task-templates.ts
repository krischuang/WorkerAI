import { prisma } from "@/lib/prisma";

export interface BuiltInTemplate {
  name: string;
  category: string;
  taskType: "coding" | "research" | "writing" | "review" | "maintenance";
  estimatedCostLevel: "low" | "medium" | "high";
  priority: "P1" | "P2" | "P3" | "P4";
  titleTemplate: string;
  descriptionTemplate: string;
  variables: string[];
}

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    name: "Code Review",
    category: "review",
    taskType: "review",
    estimatedCostLevel: "low",
    priority: "P2",
    titleTemplate: "Code review: {{target}}",
    descriptionTemplate:
      "Review the code in {{target}} for correctness, readability, and adherence to project conventions.\n\n" +
      "Focus areas:\n" +
      "- Logic errors and edge cases\n" +
      "- Code style and naming\n" +
      "- Test coverage\n" +
      "- Security concerns\n\n" +
      "{{extra_context}}",
    variables: ["target", "extra_context"],
  },
  {
    name: "Write Tests",
    category: "testing",
    taskType: "coding",
    estimatedCostLevel: "medium",
    priority: "P3",
    titleTemplate: "Write tests for {{target}}",
    descriptionTemplate:
      "Write comprehensive tests for {{target}}.\n\n" +
      "Requirements:\n" +
      "- Cover happy-path and edge cases\n" +
      "- Mock external dependencies where appropriate\n" +
      "- Follow the existing test conventions in the project\n\n" +
      "{{extra_context}}",
    variables: ["target", "extra_context"],
  },
  {
    name: "Fix Bug",
    category: "bugfix",
    taskType: "coding",
    estimatedCostLevel: "medium",
    priority: "P2",
    titleTemplate: "Fix: {{bug_description}}",
    descriptionTemplate:
      "## Bug Description\n{{bug_description}}\n\n" +
      "## Steps to Reproduce\n{{steps_to_reproduce}}\n\n" +
      "## Expected Behaviour\n{{expected_behaviour}}\n\n" +
      "## Notes\n{{extra_context}}",
    variables: ["bug_description", "steps_to_reproduce", "expected_behaviour", "extra_context"],
  },
  {
    name: "Update Documentation",
    category: "docs",
    taskType: "writing",
    estimatedCostLevel: "low",
    priority: "P3",
    titleTemplate: "Update docs: {{target}}",
    descriptionTemplate:
      "Update the documentation for {{target}}.\n\n" +
      "Scope of changes:\n{{scope}}\n\n" +
      "Ensure the documentation is accurate, clear, and consistent with the current implementation.\n\n" +
      "{{extra_context}}",
    variables: ["target", "scope", "extra_context"],
  },
  {
    name: "Refactor",
    category: "refactor",
    taskType: "coding",
    estimatedCostLevel: "medium",
    priority: "P3",
    titleTemplate: "Refactor: {{target}}",
    descriptionTemplate:
      "Refactor {{target}} to improve {{goal}}.\n\n" +
      "Guidelines:\n" +
      "- Preserve existing behaviour (all tests must still pass)\n" +
      "- Keep changes focused — do not expand scope\n" +
      "- Document any non-obvious decisions\n\n" +
      "{{extra_context}}",
    variables: ["target", "goal", "extra_context"],
  },
];

export async function ensureBuiltInTemplates(): Promise<void> {
  for (const tpl of BUILT_IN_TEMPLATES) {
    const existing = await prisma.taskTemplate.findFirst({
      where: { name: tpl.name, isBuiltIn: true },
    });
    if (!existing) {
      await prisma.taskTemplate.create({
        data: {
          ...tpl,
          variables: tpl.variables,
          isBuiltIn: true,
        },
      });
    }
  }
}

/** Safe {{variable}} substitution — no eval, no template engines. */
export function applyTemplateVariables(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? "") : `{{${key}}}`;
  });
}
