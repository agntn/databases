import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  connectionVariable,
  listConnections,
  parseReference,
  redactUrl,
  scrub,
  secretsOf,
} from "../src/core/reference.ts";
import { DatabasesError } from "../src/core/errors.ts";

describe("parseReference", () => {
  it.each([
    ["postgres://u:p@h/db", "postgres", "postgres://u:p@h/db", "postgres://u:***@h/db"],
    ["postgresql://h/db", "postgres", "postgresql://h/db", "postgresql://h/db"],
    ["sqlite:/tmp/a.db", "sqlite", "/tmp/a.db", "/tmp/a.db"],
    ["sqlite:///tmp/a.db", "sqlite", "/tmp/a.db", "/tmp/a.db"],
    ["file:///tmp/a.sqlite", "sqlite", "/tmp/a.sqlite", "/tmp/a.sqlite"],
    ["/var/data/x", "sqlite", "/var/data/x", "/var/data/x"],
    ["d1:my-app", "d1", "my-app", "d1:my-app"],
  ])("reads %s", (reference, provider, target, label) => {
    expect(parseReference(reference, {})).toMatchObject({ provider, target, label });
  });

  it("makes a relative path absolute and expands ~", () => {
    expect(parseReference("./x.db", {}).target).toBe(resolve("x.db"));
    expect(parseReference("shop.sqlite3", {}).target).toBe(resolve("shop.sqlite3"));
    expect(parseReference("~/a.db", {}).target).toBe(`${homedir()}/a.db`);
  });

  it("keeps the account of an explicit D1 reference", () => {
    const account = "0123456789abcdef0123456789abcdef";
    expect(parseReference(`d1://${account}/main`, {})).toEqual({
      provider: "d1",
      target: "main",
      account,
      label: `d1://${account}/main`,
    });
  });

  it("looks a bare word up as a connection and keeps the name", () => {
    const env = { DATABASES_SHOP_PROD_URL: "postgres://reader:pw123@db/shop" };

    expect(parseReference("shop-prod", env)).toEqual({
      provider: "postgres",
      target: "postgres://reader:pw123@db/shop",
      label: "postgres://reader:***@db/shop",
      name: "shop-prod",
    });
    expect(parseReference("SHOP_PROD", env).name).toBe("shop_prod");
  });

  it("names the missing variable and the configured connections", () => {
    const env = { DATABASES_MAIN_URL: "sqlite:/tmp/m.db" };

    expect(() => parseReference("other", env)).toThrow(
      'No connection named "other": DATABASES_OTHER_URL is not set. Configured: main',
    );
    expect(() => parseReference("other", {})).toThrow("No connection is configured");
  });

  it.each(["", "  ", "mysql://h/db", "a b", "d1:", "d1:a/b", "sqlite:", "sqlite::memory:"])(
    "refuses %j as config",
    (reference) => {
      let caught: unknown;
      try {
        parseReference(reference, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatabasesError);
      expect((caught as DatabasesError).code).toBe("config");
    },
  );

  it("refuses a variable that holds no database URL", () => {
    expect(() => parseReference("x", { DATABASES_X_URL: "redis://h" })).toThrow(
      "DATABASES_X_URL holds no database URL",
    );
  });
});

describe("listConnections", () => {
  it("lists named connections with passwords hidden, sorted, skipping junk", () => {
    expect(
      listConnections({
        DATABASES_ZED_URL: "d1:zed",
        DATABASES_SHOP_PROD_URL: "postgres://u:secret@h/db?password=x",
        DATABASES_BROKEN_URL: "nonsense",
        DATABASES_WRITE: "1",
        OTHER_URL: "postgres://h/db",
      }),
    ).toEqual([
      {
        name: "shop-prod",
        variable: "DATABASES_SHOP_PROD_URL",
        provider: "postgres",
        label: "postgres://u:***@h/db?password=***",
      },
      { name: "zed", variable: "DATABASES_ZED_URL", provider: "d1", label: "d1:zed" },
    ]);
  });

  it("maps a name to its variable", () => {
    expect(connectionVariable("shop-prod")).toBe("DATABASES_SHOP_PROD_URL");
  });
});

describe("secrets", () => {
  it("redacts a password even in a URL it can't parse", () => {
    expect(redactUrl("postgres://u:p@ss@[bad/db")).toBe("postgres://u:***@ss@[bad/db");
  });

  it("finds the raw and decoded password and scrubs both", () => {
    const target = parseReference("postgres://u:p%40ssword@h/db?sslpassword=zzz", {});
    const secrets = secretsOf(target);

    expect(secrets).toEqual(expect.arrayContaining(["p%40ssword", "p@ssword", "zzz"]));
    expect(scrub("auth failed for p@ssword and zzz", secrets)).toBe("auth failed for *** and ***");
    expect(secretsOf(parseReference("/tmp/a.db", {}))).toEqual([]);
  });
});
