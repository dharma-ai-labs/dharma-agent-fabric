// Root wrapper that marks low-value routes noindex,follow at build time.
// Kept in sync with the sitemap ignorePatterns in docusaurus.config.js; see
// docs/specs/2026-07-31-docs-seo-index-hygiene.md for the rationale.
import React from "react";
import Head from "@docusaurus/Head";
import { useLocation } from "@docusaurus/router";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

function isThinRoute(route) {
  return (
    route === "search" ||
    route === "blog/archive" ||
    route === "blog/tags" ||
    route.startsWith("blog/tags/") ||
    route === "blog/authors" ||
    route.startsWith("blog/authors/")
  );
}

function isUntranslatedBlogRoute(route, currentLocale, defaultLocale) {
  // The zh-Hans blog falls back to English posts until real Chinese articles
  // exist; keep it crawlable but out of the index to avoid language-mismatch
  // and duplicate-content signals.
  if (currentLocale === defaultLocale) {
    return false;
  }
  return route === "blog" || route.startsWith("blog/");
}

export default function Root({ children }) {
  const { pathname } = useLocation();
  const {
    siteConfig: { baseUrl },
    i18n: { currentLocale, defaultLocale },
  } = useDocusaurusContext();

  // Localized builds bake the locale into baseUrl; strip both the baseUrl and
  // any leading locale segment so route checks stay locale-relative.
  const route = (
    pathname.startsWith(baseUrl) ? pathname.slice(baseUrl.length) : pathname
  )
    .replace(new RegExp(`^${currentLocale}/`, "u"), "")
    .replace(/\/+$/u, "");

  const noindex =
    isThinRoute(route) ||
    isUntranslatedBlogRoute(route, currentLocale, defaultLocale);

  return (
    <>
      {noindex && (
        <Head>
          <meta name="robots" content="noindex, follow" />
        </Head>
      )}
      {children}
    </>
  );
}
