import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DOCS_PATH,
  DOCS_ROUTE_QUERY_PARAM,
  DOCS_ROUTE_QUERY_VALUE,
  isDocsPath,
  isDocsRoute,
} from "../src/lib/open-documentation.ts";

describe("isDocsPath", () => {
  test("matches /docs and nested paths", () => {
    assert.equal(isDocsPath(DOCS_PATH), true);
    assert.equal(isDocsPath(`${DOCS_PATH}/guides`), true);
    assert.equal(isDocsPath("/agent"), false);
  });
});

describe("isDocsRoute", () => {
  test("matches pathname /docs", () => {
    assert.equal(isDocsRoute({ pathname: DOCS_PATH, search: "" }), true);
  });

  test("matches packaged desktop query route", () => {
    assert.equal(
      isDocsRoute({
        pathname: "/index.html",
        search: `?${DOCS_ROUTE_QUERY_PARAM}=${DOCS_ROUTE_QUERY_VALUE}`,
      }),
      true
    );
  });

  test("rejects agent settings URL", () => {
    assert.equal(
      isDocsRoute({ pathname: "/agent", search: "?view=settings" }),
      false
    );
  });
});
