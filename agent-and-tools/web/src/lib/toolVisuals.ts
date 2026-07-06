import type { LucideIcon } from "lucide-react";
import type { SimpleIcon } from "simple-icons";
import {
  Boxes,
  BrainCircuit,
  DatabaseZap,
  FileText,
  GitPullRequest,
  Globe2,
  KeyRound,
  PackageSearch,
  PlugZap,
  SearchCode,
  ShieldCheck,
  Terminal,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import {
  siArgo,
  siAsana,
  siAnthropic,
  siBitbucket,
  siClickup,
  siClaude,
  siConfluence,
  siDatadog,
  siDocker,
  siElasticsearch,
  siGit,
  siGithub,
  siGithubactions,
  siGithubcopilot,
  siGitlab,
  siGooglecloud,
  siGrafana,
  siJenkins,
  siJirasoftware,
  siKubernetes,
  siLinear,
  siMongodb,
  siNotion,
  siPostgresql,
  siPrometheus,
  siRedis,
  siSnyk,
  siSonarqubeserver,
  siSplunk,
  siTerraform,
  siTrello,
  siVault,
  siZendesk,
} from "simple-icons";

export type ToolVisualTone = "emerald" | "blue" | "cyan" | "violet" | "amber" | "rose" | "slate";

export type ToolProductVisual = {
  key: string;
  name: string;
  mark: string;
  simpleIcon?: SimpleIcon;
  tileClass: string;
  chipClass: string;
};

export type ToolVisual = {
  icon: LucideIcon;
  tone: ToolVisualTone;
  label: string;
  product?: ToolProductVisual;
};

export const toolRegistryVisual: ToolVisual = {
  icon: Boxes,
  tone: "violet",
  label: "Tool registry",
};

const TOOL_VISUAL_PILLS: Record<ToolVisualTone, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  cyan: "border-cyan-200 bg-cyan-50 text-cyan-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  slate: "border-slate-200 bg-slate-50 text-slate-600",
};

function valueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(" ");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(valueText).join(" ");
  return "";
}

function haystack(tool: Record<string, unknown> | null | undefined): string {
  if (!tool) return "";
  return [
    tool.tool_name,
    tool.display_name,
    tool.namespace,
    tool.name,
    tool.description,
    tool.category,
    tool.kind,
    tool.type,
    tool.execution_target,
    tool.tags,
    tool.runtime,
    tool.input_schema,
    tool.output_schema,
  ].map(valueText).join(" ").toLowerCase();
}

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function productVisualFor(text: string): ToolVisual | null {
  const products: Array<{ pattern: RegExp; visual: ToolVisual }> = [
    {
      pattern: /\b(github[_ -]?copilot|copilot)\b/,
      visual: {
        icon: BrainCircuit,
        tone: "violet",
        label: "GitHub Copilot",
        product: {
          key: "github-copilot",
          name: "GitHub Copilot",
          mark: "CP",
          simpleIcon: siGithubcopilot,
          tileClass: "bg-violet-950 text-white ring-violet-300",
          chipClass: "border-violet-200 bg-violet-50 text-violet-800",
        },
      },
    },
    {
      pattern: /\b(github[_ -]?actions|actions)\b/,
      visual: {
        icon: Workflow,
        tone: "blue",
        label: "GitHub Actions",
        product: {
          key: "github-actions",
          name: "GitHub Actions",
          mark: "GA",
          simpleIcon: siGithubactions,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\bgithub\b/,
      visual: {
        icon: GitPullRequest,
        tone: "slate",
        label: "GitHub",
        product: {
          key: "github",
          name: "GitHub",
          mark: "GH",
          simpleIcon: siGithub,
          tileClass: "bg-slate-950 text-white ring-slate-300",
          chipClass: "border-slate-300 bg-slate-950 text-white",
        },
      },
    },
    {
      pattern: /\bgit\b/,
      visual: {
        icon: GitPullRequest,
        tone: "rose",
        label: "Git",
        product: {
          key: "git",
          name: "Git",
          mark: "Git",
          simpleIcon: siGit,
          tileClass: "bg-red-50 text-red-700 ring-red-200",
          chipClass: "border-red-200 bg-red-50 text-red-700",
        },
      },
    },
    {
      pattern: /\bgitlab\b/,
      visual: {
        icon: GitPullRequest,
        tone: "amber",
        label: "GitLab",
        product: {
          key: "gitlab",
          name: "GitLab",
          mark: "GL",
          simpleIcon: siGitlab,
          tileClass: "bg-orange-50 text-orange-700 ring-orange-200",
          chipClass: "border-orange-200 bg-orange-50 text-orange-700",
        },
      },
    },
    {
      pattern: /\b(bitbucket|bb)\b/,
      visual: {
        icon: GitPullRequest,
        tone: "blue",
        label: "Bitbucket",
        product: {
          key: "bitbucket",
          name: "Bitbucket",
          mark: "BB",
          simpleIcon: siBitbucket,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\b(jira[_ -]?software|jira)\b/,
      visual: {
        icon: Workflow,
        tone: "blue",
        label: "Jira Software",
        product: {
          key: "jira",
          name: "Jira Software",
          mark: "J",
          simpleIcon: siJirasoftware,
          tileClass: "bg-blue-600 text-white ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\btrello\b/,
      visual: {
        icon: Workflow,
        tone: "blue",
        label: "Trello",
        product: {
          key: "trello",
          name: "Trello",
          mark: "Tr",
          simpleIcon: siTrello,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\basana\b/,
      visual: {
        icon: Workflow,
        tone: "rose",
        label: "Asana",
        product: {
          key: "asana",
          name: "Asana",
          mark: "As",
          simpleIcon: siAsana,
          tileClass: "bg-rose-50 text-rose-700 ring-rose-200",
          chipClass: "border-rose-200 bg-rose-50 text-rose-700",
        },
      },
    },
    {
      pattern: /\bclickup\b/,
      visual: {
        icon: Workflow,
        tone: "violet",
        label: "ClickUp",
        product: {
          key: "clickup",
          name: "ClickUp",
          mark: "CU",
          simpleIcon: siClickup,
          tileClass: "bg-violet-50 text-violet-700 ring-violet-200",
          chipClass: "border-violet-200 bg-violet-50 text-violet-700",
        },
      },
    },
    {
      pattern: /\bconfluence\b/,
      visual: {
        icon: FileText,
        tone: "blue",
        label: "Confluence",
        product: {
          key: "confluence",
          name: "Confluence",
          mark: "C",
          simpleIcon: siConfluence,
          tileClass: "bg-sky-600 text-white ring-sky-200",
          chipClass: "border-sky-200 bg-sky-50 text-sky-700",
        },
      },
    },
    {
      pattern: /\b(google[_ -]?cloud|gcp)\b/,
      visual: {
        icon: Globe2,
        tone: "blue",
        label: "Google Cloud",
        product: {
          key: "google-cloud",
          name: "Google Cloud",
          mark: "GC",
          simpleIcon: siGooglecloud,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\b(azure[_ -]?devops|ado|azure repos|azure boards)\b/,
      visual: {
        icon: Workflow,
        tone: "cyan",
        label: "Azure DevOps",
        product: {
          key: "azure-devops",
          name: "Azure DevOps",
          mark: "Az",
          tileClass: "bg-cyan-600 text-white ring-cyan-200",
          chipClass: "border-cyan-200 bg-cyan-50 text-cyan-700",
        },
      },
    },
    {
      pattern: /\b(claude[_ -]?code|claude)\b/,
      visual: {
        icon: BrainCircuit,
        tone: "amber",
        label: "Claude",
        product: {
          key: "claude",
          name: "Claude",
          mark: "Cl",
          simpleIcon: siClaude,
          tileClass: "bg-orange-50 text-orange-700 ring-orange-200",
          chipClass: "border-orange-200 bg-orange-50 text-orange-700",
        },
      },
    },
    {
      pattern: /\b(openai|gpt|chatgpt)\b/,
      visual: {
        icon: BrainCircuit,
        tone: "emerald",
        label: "OpenAI",
        product: {
          key: "openai",
          name: "OpenAI",
          mark: "AI",
          tileClass: "bg-emerald-950 text-white ring-emerald-300",
          chipClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
        },
      },
    },
    {
      pattern: /\b(anthropic|claude)\b/,
      visual: {
        icon: BrainCircuit,
        tone: "amber",
        label: "Anthropic",
        product: {
          key: "anthropic",
          name: "Anthropic",
          mark: "An",
          simpleIcon: siAnthropic,
          tileClass: "bg-stone-900 text-amber-50 ring-stone-300",
          chipClass: "border-stone-200 bg-stone-50 text-stone-800",
        },
      },
    },
    {
      pattern: /\bslack\b/,
      visual: {
        icon: Zap,
        tone: "violet",
        label: "Slack",
        product: {
          key: "slack",
          name: "Slack",
          mark: "#",
          tileClass: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
          chipClass: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        },
      },
    },
    {
      pattern: /\blinear\b/,
      visual: {
        icon: Workflow,
        tone: "violet",
        label: "Linear",
        product: {
          key: "linear",
          name: "Linear",
          mark: "L",
          simpleIcon: siLinear,
          tileClass: "bg-indigo-950 text-white ring-indigo-300",
          chipClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
        },
      },
    },
    {
      pattern: /\bzendesk\b/,
      visual: {
        icon: Workflow,
        tone: "emerald",
        label: "Zendesk",
        product: {
          key: "zendesk",
          name: "Zendesk",
          mark: "ZD",
          simpleIcon: siZendesk,
          tileClass: "bg-emerald-50 text-emerald-700 ring-emerald-200",
          chipClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
        },
      },
    },
    {
      pattern: /\bnotion\b/,
      visual: {
        icon: FileText,
        tone: "slate",
        label: "Notion",
        product: {
          key: "notion",
          name: "Notion",
          mark: "N",
          simpleIcon: siNotion,
          tileClass: "bg-white text-slate-950 ring-slate-300",
          chipClass: "border-slate-200 bg-white text-slate-800",
        },
      },
    },
    {
      pattern: /\bsnyk\b/,
      visual: {
        icon: ShieldCheck,
        tone: "violet",
        label: "Snyk",
        product: {
          key: "snyk",
          name: "Snyk",
          mark: "Sk",
          simpleIcon: siSnyk,
          tileClass: "bg-violet-50 text-violet-700 ring-violet-200",
          chipClass: "border-violet-200 bg-violet-50 text-violet-700",
        },
      },
    },
    {
      pattern: /\b(docker|container)\b/,
      visual: {
        icon: Terminal,
        tone: "blue",
        label: "Docker",
        product: {
          key: "docker",
          name: "Docker",
          mark: "D",
          simpleIcon: siDocker,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\b(kubernetes|k8s)\b/,
      visual: {
        icon: Workflow,
        tone: "blue",
        label: "Kubernetes",
        product: {
          key: "kubernetes",
          name: "Kubernetes",
          mark: "K8s",
          simpleIcon: siKubernetes,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\bterraform\b/,
      visual: {
        icon: FileText,
        tone: "violet",
        label: "Terraform",
        product: {
          key: "terraform",
          name: "Terraform",
          mark: "Tf",
          simpleIcon: siTerraform,
          tileClass: "bg-violet-50 text-violet-700 ring-violet-200",
          chipClass: "border-violet-200 bg-violet-50 text-violet-700",
        },
      },
    },
    {
      pattern: /\b(vault|hashicorp[_ -]?vault)\b/,
      visual: {
        icon: ShieldCheck,
        tone: "amber",
        label: "Vault",
        product: {
          key: "vault",
          name: "Vault",
          mark: "V",
          simpleIcon: siVault,
          tileClass: "bg-amber-50 text-amber-700 ring-amber-200",
          chipClass: "border-amber-200 bg-amber-50 text-amber-800",
        },
      },
    },
    {
      pattern: /\b(postgres|postgresql)\b/,
      visual: {
        icon: DatabaseZap,
        tone: "blue",
        label: "PostgreSQL",
        product: {
          key: "postgresql",
          name: "PostgreSQL",
          mark: "PG",
          simpleIcon: siPostgresql,
          tileClass: "bg-blue-50 text-blue-700 ring-blue-200",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
    {
      pattern: /\bmongo(db)?\b/,
      visual: {
        icon: DatabaseZap,
        tone: "emerald",
        label: "MongoDB",
        product: {
          key: "mongodb",
          name: "MongoDB",
          mark: "Mg",
          simpleIcon: siMongodb,
          tileClass: "bg-emerald-50 text-emerald-700 ring-emerald-200",
          chipClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
        },
      },
    },
    {
      pattern: /\bredis\b/,
      visual: {
        icon: DatabaseZap,
        tone: "rose",
        label: "Redis",
        product: {
          key: "redis",
          name: "Redis",
          mark: "R",
          simpleIcon: siRedis,
          tileClass: "bg-rose-50 text-rose-700 ring-rose-200",
          chipClass: "border-rose-200 bg-rose-50 text-rose-700",
        },
      },
    },
    {
      pattern: /\belastic(search)?\b/,
      visual: {
        icon: DatabaseZap,
        tone: "cyan",
        label: "Elasticsearch",
        product: {
          key: "elasticsearch",
          name: "Elasticsearch",
          mark: "Es",
          simpleIcon: siElasticsearch,
          tileClass: "bg-cyan-50 text-cyan-700 ring-cyan-200",
          chipClass: "border-cyan-200 bg-cyan-50 text-cyan-700",
        },
      },
    },
    {
      pattern: /\bservicenow\b/,
      visual: {
        icon: Workflow,
        tone: "emerald",
        label: "ServiceNow",
        product: {
          key: "servicenow",
          name: "ServiceNow",
          mark: "SN",
          tileClass: "bg-emerald-50 text-emerald-700 ring-emerald-200",
          chipClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
        },
      },
    },
    {
      pattern: /\b(jenkins|ci\/cd|cicd)\b/,
      visual: {
        icon: Terminal,
        tone: "rose",
        label: "Jenkins",
        product: {
          key: "jenkins",
          name: "Jenkins",
          mark: "Jk",
          simpleIcon: siJenkins,
          tileClass: "bg-red-50 text-red-700 ring-red-200",
          chipClass: "border-red-200 bg-red-50 text-red-700",
        },
      },
    },
    {
      pattern: /\bargo(cd| workflows)?\b/,
      visual: {
        icon: Workflow,
        tone: "amber",
        label: "Argo",
        product: {
          key: "argo",
          name: "Argo",
          mark: "Ar",
          simpleIcon: siArgo,
          tileClass: "bg-orange-50 text-orange-700 ring-orange-200",
          chipClass: "border-orange-200 bg-orange-50 text-orange-700",
        },
      },
    },
    {
      pattern: /\b(datadog)\b/,
      visual: {
        icon: Zap,
        tone: "violet",
        label: "Datadog",
        product: {
          key: "datadog",
          name: "Datadog",
          mark: "DD",
          simpleIcon: siDatadog,
          tileClass: "bg-violet-50 text-violet-700 ring-violet-200",
          chipClass: "border-violet-200 bg-violet-50 text-violet-700",
        },
      },
    },
    {
      pattern: /\bsplunk\b/,
      visual: {
        icon: Zap,
        tone: "slate",
        label: "Splunk",
        product: {
          key: "splunk",
          name: "Splunk",
          mark: "Sp",
          simpleIcon: siSplunk,
          tileClass: "bg-slate-50 text-slate-900 ring-slate-200",
          chipClass: "border-slate-200 bg-slate-50 text-slate-800",
        },
      },
    },
    {
      pattern: /\bgrafana\b/,
      visual: {
        icon: Zap,
        tone: "amber",
        label: "Grafana",
        product: {
          key: "grafana",
          name: "Grafana",
          mark: "Gf",
          simpleIcon: siGrafana,
          tileClass: "bg-orange-50 text-orange-700 ring-orange-200",
          chipClass: "border-orange-200 bg-orange-50 text-orange-700",
        },
      },
    },
    {
      pattern: /\bprometheus\b/,
      visual: {
        icon: Zap,
        tone: "rose",
        label: "Prometheus",
        product: {
          key: "prometheus",
          name: "Prometheus",
          mark: "Pr",
          simpleIcon: siPrometheus,
          tileClass: "bg-rose-50 text-rose-700 ring-rose-200",
          chipClass: "border-rose-200 bg-rose-50 text-rose-700",
        },
      },
    },
    {
      pattern: /\b(sonarqube|sonar)\b/,
      visual: {
        icon: ShieldCheck,
        tone: "blue",
        label: "SonarQube",
        product: {
          key: "sonarqube",
          name: "SonarQube",
          mark: "SQ",
          simpleIcon: siSonarqubeserver,
          tileClass: "bg-blue-950 text-white ring-blue-300",
          chipClass: "border-blue-200 bg-blue-50 text-blue-700",
        },
      },
    },
  ];

  return products.find(product => product.pattern.test(text))?.visual ?? null;
}

export function toolVisualFor(tool: Record<string, unknown> | null | undefined): ToolVisual {
  const text = haystack(tool);
  const product = productVisualFor(text);
  if (product) return product;

  if (matches(text, /\b(github|gitlab|git|repo|repository|branch|commit|pull[_ -]?request|pr|diff|merge|clone)\b/)) {
    return { icon: GitPullRequest, tone: "blue", label: "Git and repo" };
  }
  if (matches(text, /\b(search|grep|query|lookup|discover|index|scan|find)\b/)) {
    return { icon: SearchCode, tone: "cyan", label: "Search" };
  }
  if (matches(text, /\b(browser|web|http|https|url|api|rest|graphql|endpoint|fetch|crawl)\b/)) {
    return { icon: Globe2, tone: "blue", label: "Web/API" };
  }
  if (matches(text, /\b(file|document|docx|xlsx|pptx|pdf|artifact|upload|download|markdown|md|txt|storage)\b/)) {
    return { icon: FileText, tone: "amber", label: "Document/artifact" };
  }
  if (matches(text, /\b(code|source|script|shell|terminal|python|node|npm|build|test|lint|compile)\b/)) {
    return { icon: Terminal, tone: "slate", label: "Code execution" };
  }
  if (matches(text, /\b(database|db|sql|postgres|vector|memory|embedding|store|cache)\b/)) {
    return { icon: DatabaseZap, tone: "cyan", label: "Data store" };
  }
  if (matches(text, /\b(model|llm|prompt|compose|completion|chat|embedding|anthropic|openai|copilot)\b/)) {
    return { icon: BrainCircuit, tone: "violet", label: "Model/prompt" };
  }
  if (matches(text, /\b(workflow|workgraph|run|execution|orchestrat|planner|stage|node)\b/)) {
    return { icon: Workflow, tone: "emerald", label: "Workflow" };
  }
  if (matches(text, /\b(mcp|provider|connector|integration|manifest|runtime|bridge)\b/)) {
    return { icon: PlugZap, tone: "emerald", label: "Runtime/provider" };
  }
  if (matches(text, /\b(policy|guard|governance|approval|authorize|auth|token|key|grant|permission|security)\b/)) {
    return { icon: ShieldCheck, tone: "amber", label: "Governed" };
  }
  if (matches(text, /\b(validate|verify|z3|formal|proof|evidence|audit|attest)\b/)) {
    return { icon: ShieldCheck, tone: "rose", label: "Verification" };
  }
  if (matches(text, /\b(queue|event|signal|notify|webhook|stream)\b/)) {
    return { icon: Zap, tone: "emerald", label: "Evented" };
  }
  if (matches(text, /\b(registry|catalog|tool|package)\b/)) {
    return { icon: PackageSearch, tone: "violet", label: "Registry" };
  }

  return { icon: Wrench, tone: "slate", label: "Tool" };
}

export function toolVisualPillClass(tone: ToolVisualTone): string {
  return TOOL_VISUAL_PILLS[tone];
}

export function toolGrantVisual(): ToolVisual {
  return { icon: KeyRound, tone: "amber", label: "Tool grant" };
}
