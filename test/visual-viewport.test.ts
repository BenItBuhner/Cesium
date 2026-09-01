import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  VISUAL_VIEWPORT_HEIGHT_VAR,
  VISUAL_VIEWPORT_LEFT_VAR,
  VISUAL_VIEWPORT_TOP_VAR,
  VISUAL_VIEWPORT_WIDTH_VAR,
  WORKBENCH_VIEWPORT_CLASS,
  applyVisualViewportVars,
  buildVisualViewportBootstrapScript,
  installVisualViewportLock,
  isWorkbenchViewportPath,
  readVisualViewport,
  setWorkbenchViewportClass,
  subscribeVisualViewport,
  syncVisualViewport,
} from "../src/lib/visual-viewport.ts";

function styleTarget() {
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  return {
    properties,
    classes,
    root: {
      style: {
        setProperty: (name: string, value: string) => {
          properties.set(name, value);
        },
      },
      classList: {
        add: (name: string) => {
          classes.add(name);
        },
        remove: (name: string) => {
          classes.delete(name);
        },
      },
    },
  };
}

describe("visual viewport lock", () => {
  test("prefers visualViewport metrics over inner window size", () => {
    const metrics = readVisualViewport({
      innerHeight: 900,
      innerWidth: 400,
      visualViewport: {
        height: 640,
        width: 390,
        offsetTop: 12,
        offsetLeft: 3,
      },
    });

    assert.deepEqual(metrics, {
      height: 640,
      width: 390,
      offsetTop: 12,
      offsetLeft: 3,
    });
  });

  test("falls back to inner window size when visualViewport is missing", () => {
    const metrics = readVisualViewport({
      innerHeight: 812,
      innerWidth: 375,
    });

    assert.deepEqual(metrics, {
      height: 812,
      width: 375,
      offsetTop: 0,
      offsetLeft: 0,
    });
  });

  test("writes CSS variables in pixels", () => {
    const { root, properties } = styleTarget();
    applyVisualViewportVars(root, {
      height: 640,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
    });

    assert.equal(properties.get(VISUAL_VIEWPORT_HEIGHT_VAR), "640px");
    assert.equal(properties.get(VISUAL_VIEWPORT_WIDTH_VAR), "390px");
    assert.equal(properties.get(VISUAL_VIEWPORT_TOP_VAR), "0px");
    assert.equal(properties.get(VISUAL_VIEWPORT_LEFT_VAR), "0px");
  });

  test("syncs the current visual viewport onto the document root", () => {
    const { root, properties } = styleTarget();
    const metrics = syncVisualViewport(
      {
        innerHeight: 900,
        innerWidth: 400,
        visualViewport: { height: 620, width: 390, offsetTop: 8, offsetLeft: 0 },
      },
      root
    );

    assert.equal(metrics.height, 620);
    assert.equal(properties.get(VISUAL_VIEWPORT_HEIGHT_VAR), "620px");
    assert.equal(properties.get(VISUAL_VIEWPORT_TOP_VAR), "8px");
  });

  test("recognizes workbench paths including legacy redirects", () => {
    assert.equal(isWorkbenchViewportPath("/agent"), true);
    assert.equal(isWorkbenchViewportPath("/agent/extra"), true);
    assert.equal(isWorkbenchViewportPath("/workspace"), true);
    assert.equal(isWorkbenchViewportPath("/editor"), true);
    assert.equal(isWorkbenchViewportPath("/"), false);
    assert.equal(isWorkbenchViewportPath("/sign-in"), false);
  });

  test("toggles the workbench document class", () => {
    const { root, classes } = styleTarget();
    setWorkbenchViewportClass(root, true);
    assert.equal(classes.has(WORKBENCH_VIEWPORT_CLASS), true);
    setWorkbenchViewportClass(root, false);
    assert.equal(classes.has(WORKBENCH_VIEWPORT_CLASS), false);
  });

  test("installs listeners and keeps vars in sync", () => {
    const { root, properties, classes } = styleTarget();
    const listeners = new Map<string, Array<() => void>>();
    const visualListeners = new Map<string, Array<() => void>>();
    const visual = {
      height: 640,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: (type: string, listener: () => void) => {
        const list = visualListeners.get(type) ?? [];
        list.push(listener);
        visualListeners.set(type, list);
      },
      removeEventListener: (type: string, listener: () => void) => {
        const list = (visualListeners.get(type) ?? []).filter((item) => item !== listener);
        visualListeners.set(type, list);
      },
    };

    const uninstall = installVisualViewportLock(
      {
        innerHeight: 900,
        innerWidth: 400,
        visualViewport: visual,
        location: { pathname: "/agent" },
        document: { documentElement: root },
        addEventListener: (type: string, listener: () => void) => {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        removeEventListener: (type: string, listener: () => void) => {
          const list = (listeners.get(type) ?? []).filter((item) => item !== listener);
          listeners.set(type, list);
        },
      },
      { lockWorkbenchClass: true }
    );

    assert.equal(properties.get(VISUAL_VIEWPORT_HEIGHT_VAR), "640px");
    assert.equal(classes.has(WORKBENCH_VIEWPORT_CLASS), true);

    visual.height = 580;
    for (const listener of visualListeners.get("resize") ?? []) {
      listener();
    }
    assert.equal(properties.get(VISUAL_VIEWPORT_HEIGHT_VAR), "580px");

    uninstall();
    assert.equal((visualListeners.get("resize") ?? []).length, 0);
    assert.equal((listeners.get("resize") ?? []).length, 0);
  });

  test("subscribeVisualViewport detaches every listener", () => {
    const attached: string[] = [];
    const detached: string[] = [];
    const visual = {
      addEventListener: (type: string) => {
        attached.push(`visual:${type}`);
      },
      removeEventListener: (type: string) => {
        detached.push(`visual:${type}`);
      },
    };
    const unsubscribe = subscribeVisualViewport(
      {
        visualViewport: visual,
        addEventListener: (type: string) => {
          attached.push(`window:${type}`);
        },
        removeEventListener: (type: string) => {
          detached.push(`window:${type}`);
        },
      },
      () => {}
    );

    assert.deepEqual(attached, [
      "visual:resize",
      "visual:scroll",
      "window:resize",
      "window:orientationchange",
    ]);
    unsubscribe();
    assert.deepEqual(detached, attached);
  });
});

describe("visual viewport bootstrap script", () => {
  test("applies visual viewport vars and the workbench class on /agent", () => {
    const properties = new Map<string, string>();
    const classes = new Set<string>();
    const visualListeners: string[] = [];

    vm.runInNewContext(buildVisualViewportBootstrapScript(), {
      window: {
        innerHeight: 900,
        innerWidth: 400,
        visualViewport: {
          height: 640,
          width: 390,
          offsetTop: 0,
          offsetLeft: 0,
          addEventListener: (type: string) => {
            visualListeners.push(type);
          },
        },
        addEventListener() {},
      },
      document: {
        documentElement: {
          style: {
            setProperty: (name: string, value: string) => {
              properties.set(name, value);
            },
          },
          classList: {
            add: (name: string) => {
              classes.add(name);
            },
          },
        },
      },
      location: { pathname: "/agent" },
    });

    assert.equal(properties.get(VISUAL_VIEWPORT_HEIGHT_VAR), "640px");
    assert.equal(properties.get(VISUAL_VIEWPORT_WIDTH_VAR), "390px");
    assert.equal(classes.has(WORKBENCH_VIEWPORT_CLASS), true);
    assert.deepEqual(visualListeners, ["resize", "scroll"]);
  });

  test("does not lock the landing page document class", () => {
    const classes = new Set<string>();

    vm.runInNewContext(buildVisualViewportBootstrapScript(), {
      window: {
        innerHeight: 800,
        innerWidth: 1280,
        addEventListener() {},
      },
      document: {
        documentElement: {
          style: {
            setProperty() {},
          },
          classList: {
            add: (name: string) => {
              classes.add(name);
            },
          },
        },
      },
      location: { pathname: "/" },
    });

    assert.equal(classes.has(WORKBENCH_VIEWPORT_CLASS), false);
  });
});

describe("workbench shell uses the visual viewport instead of 100vh", () => {
  test("root layout bootstraps the visual viewport before paint", () => {
    const layout = readFileSync(
      fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)),
      "utf8"
    );
    assert.match(layout, /buildVisualViewportBootstrapScript/);
    assert.match(layout, /visual-viewport-bootstrap/);
    assert.match(layout, /viewportFit:\s*"cover"/);
  });

  test("workbench providers mount the viewport lock", () => {
    const providers = readFileSync(
      fileURLToPath(
        new URL("../src/components/layout/WorkbenchRouteProviders.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(providers, /VisualViewportLock/);
  });

  test("workbench shells no longer use h-screen", () => {
    const files = [
      "../src/components/layout/WorkbenchApp.tsx",
      "../src/components/layout/AgentLayout.tsx",
      "../src/components/auth/FirstRunAccountGate.tsx",
    ];
    for (const relative of files) {
      const source = readFileSync(
        fileURLToPath(new URL(relative, import.meta.url)),
        "utf8"
      );
      assert.match(source, /cesium-app-shell/);
      assert.doesNotMatch(source, /h-screen/);
    }
  });

  test("globals lock the workbench document to the visual viewport vars", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
      "utf8"
    );
    assert.match(css, /--cesium-vvh/);
    assert.match(css, /html\.cesium-workbench-viewport/);
    assert.match(css, /\.cesium-app-shell/);
    assert.match(css, /100svh/);
  });

  test("rail footer keeps account and settings above the device safe area", () => {
    const rail = readFileSync(
      fileURLToPath(
        new URL("../src/components/agent/AgentWorkspaceRail.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(rail, /safe-area-inset-bottom/);
  });
});
