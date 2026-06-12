"use client";

import { useEffect, useRef } from "react";
import { PageHeader } from "@/app/_components/ui";

/**
 * /admin/api-docs — Swagger UI embedded via CDN.
 * The spec is served from GET /api/docs (static public/api-docs.json).
 */
export default function ApiDocsPage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load Swagger UI CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css";
    document.head.appendChild(link);

    // Load Swagger UI bundle
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js";
    script.onload = () => {
      type SwaggerUIBundleFn = {
        (opts: Record<string, unknown>): void;
        presets: { apis: unknown };
        SwaggerUIStandalonePreset: unknown;
      };
      const SwaggerUIBundle = (window as typeof window & { SwaggerUIBundle: SwaggerUIBundleFn }).SwaggerUIBundle;
      if (!SwaggerUIBundle || !containerRef.current) return;
      SwaggerUIBundle({
        url: "/api/docs",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        tryItOutEnabled: true,
        withCredentials: true,
      });
    };
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(link);
      document.head.removeChild(script);
    };
  }, []);

  return (
    <div className="p-4 md:p-8 max-w-full">
      <div className="flex items-center justify-between mb-6">
        <PageHeader
          title="API Documentation"
          subtitle="OpenAPI 3.0 specification for all WorkerAI REST endpoints"
        />
        <a
          href="/api/docs"
          download="api-docs.json"
          className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors"
        >
          Download JSON
        </a>
      </div>

      <div id="swagger-ui" ref={containerRef} />
    </div>
  );
}
