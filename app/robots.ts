import type { MetadataRoute } from "next";

/** A staff application: nothing here is for search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
