import { describe, expect, it } from "bun:test";
import { parseCompartmentOutput } from "./compartment-parser";

describe("parseCompartmentOutput — v2 5-category facts", () => {
    it("parses each of the 5 world categories", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="2" title="Setup" episode_type="infra" importance="40">
<p1>did setup</p1><p2>setup</p2><p3>setup</p3><p4/>
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Always commit + build after every fix.
</PROJECT_RULES>
<ARCHITECTURE>
* Storage is a single SQLite DB.
</ARCHITECTURE>
<CONSTRAINTS>
* Provider rejects empty assistant messages.
</CONSTRAINTS>
<CONFIG_VALUES>
* execute_threshold defaults to 65.
</CONFIG_VALUES>
<NAMING>
* The helper is named requireTenantContext.
</NAMING>
</facts>
<meta>
<unprocessed_from>3</unprocessed_from>
</meta>
</output>`);

        const cats = parsed.facts.map((f) => f.category);
        expect(cats).toEqual([
            "PROJECT_RULES",
            "ARCHITECTURE",
            "CONSTRAINTS",
            "CONFIG_VALUES",
            "NAMING",
        ]);
        expect(parsed.facts[0]).toEqual({
            category: "PROJECT_RULES",
            content: "Always commit + build after every fix.",
        });
    });

    it("does NOT parse legacy 9-cat fact categories (they exited historian output)", () => {
        const parsed = parseCompartmentOutput(`
<output>
<facts>
<USER_DIRECTIVES>
* Keep the magic-context rename broad.
</USER_DIRECTIVES>
<WORKFLOW_RULES>
* Use scripts/release.sh.
</WORKFLOW_RULES>
<ARCHITECTURE_DECISIONS>
* This should not parse as a fact.
</ARCHITECTURE_DECISIONS>
</facts>
</output>`);
        expect(parsed.facts).toEqual([]);
    });

    it("unescapes escaped XML in titles, compartments, and facts", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="5" end="6" title="Team&apos;s &quot;rules&quot;">Keep &lt;instruction&gt; blocks &amp; notes safe.</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Preserve Sam&apos;s decision &amp; keep &lt;magic-context&gt; wording.
</PROJECT_RULES>
</facts>
<meta>
<messages_processed>5-6</messages_processed>
</meta>
</output>`);

        expect(parsed.compartments).toEqual([
            {
                startMessage: 5,
                endMessage: 6,
                title: `Team's "rules"`,
                content: "Keep <instruction> blocks & notes safe.",
                importance: undefined,
                episodeType: undefined,
            },
        ]);
        expect(parsed.facts).toContainEqual({
            category: "PROJECT_RULES",
            content: "Preserve Sam's decision & keep <magic-context> wording.",
        });
    });
});

describe("parseCompartmentOutput — v2 tiers/importance/episode_type", () => {
    it("extracts four tiers, importance, and episode_type", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="10" end="20" title="Tiered" episode_type="design,feature" importance="88">
<p1>full narrative with U: line</p1>
<p2>condensed</p2>
<p3>outcome</p3>
<p4>anchorA; anchorB</p4>
</compartment>
</compartments>
</output>`);
        const c = parsed.compartments[0];
        expect(c.importance).toBe(88);
        expect(c.episodeType).toBe("design,feature");
        expect(c.p1).toBe("full narrative with U: line");
        expect(c.p2).toBe("condensed");
        expect(c.p3).toBe("outcome");
        expect(c.p4).toBe("anchorA; anchorB");
        expect(c.content).toBe("full narrative with U: line"); // mirrors P1
    });

    it("handles self-closing <p4/> as empty tier", () => {
        const parsed = parseCompartmentOutput(`
<compartment start="1" end="2" title="x" importance="30">
<p1>a</p1><p2>b</p2><p3>c</p3><p4/>
</compartment>`);
        expect(parsed.compartments[0].p4).toBe("");
    });
});

describe("parseCompartmentOutput — events (v2, stored not rendered)", () => {
    it("parses causal_incident and trajectory_correction kind-agnostically", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="9" title="x" importance="50"><p1>a</p1><p2>b</p2><p3>c</p3><p4/></compartment>
</compartments>
<events>
<causal_incident at_compartment="1">
<summary>thing broke</summary>
<affected_surface>module X</affected_surface>
<symptom>500s</symptom>
<cause_summary>missing guard</cause_summary>
<disposition>fixed</disposition>
<evidence>logs</evidence>
<fix_summary>added guard</fix_summary>
</causal_incident>
<trajectory_correction at_compartment="1">
<summary>pivoted approach</summary>
<before_strategy>old way</before_strategy>
<correction_source>user</correction_source>
<correction_signal>U: "do it differently"</correction_signal>
<after_strategy>new way</after_strategy>
<evidence>final impl</evidence>
</trajectory_correction>
</events>
</output>`);

        expect(parsed.events).toHaveLength(2);
        const [incident, correction] = parsed.events;
        expect(incident.kind).toBe("causal_incident");
        expect(incident.atCompartment).toBe(1);
        expect(incident.fields.summary).toBe("thing broke");
        expect(incident.fields.disposition).toBe("fixed");
        expect(incident.fields.fix_summary).toBe("added guard");
        expect(correction.kind).toBe("trajectory_correction");
        expect(correction.fields.before_strategy).toBe("old way");
        expect(correction.fields.correction_signal).toBe('U: "do it differently"');
    });

    it("returns [] when no events block (the common case)", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="2" title="x" importance="50"><p1>a</p1><p2>b</p2><p3>c</p3><p4/></compartment>
</compartments>
</output>`);
        expect(parsed.events).toEqual([]);
    });

    it("anchors at_compartment as a 1-based index into the EMITTED compartment list (discard-last contract)", () => {
        // The incremental runner's discard-last filter keeps an event iff
        // `atCompartment <= persistedCompartments.length` (compartment-runner-incremental.ts).
        // That is ONLY correct if at_compartment is a 1-based index into the
        // emitted compartment list. This test pins that contract: if the parser
        // ever changed to 0-based or absolute message ordinals, the filter would
        // silently mis-classify events and this assertion would break first.
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="5" title="first" importance="50"><p1>a</p1><p2>b</p2><p3>c</p3><p4/></compartment>
<compartment start="6" end="9" title="second (provisional tail)" importance="50"><p1>a</p1><p2>b</p2><p3>c</p3><p4/></compartment>
</compartments>
<events>
<causal_incident at_compartment="1">
<summary>anchored to the first (kept) compartment</summary>
<disposition>fixed</disposition>
</causal_incident>
<causal_incident at_compartment="2">
<summary>anchored to the second (discarded tail) compartment</summary>
<disposition>fixed</disposition>
</causal_incident>
</events>
</output>`);
        expect(parsed.events).toHaveLength(2);
        // First event anchors to emitted compartment #1 (1-based).
        expect(parsed.events[0].atCompartment).toBe(1);
        // Second anchors to emitted compartment #2.
        expect(parsed.events[1].atCompartment).toBe(2);

        // Simulate discard-last keeping only the first compartment (k=1 persisted).
        const persistedLength = 1;
        const publishable = parsed.events.filter(
            (e) => e.atCompartment == null || e.atCompartment <= persistedLength,
        );
        // The event on the discarded tail (#2) is dropped; the kept-compartment
        // event (#1) survives.
        expect(publishable).toHaveLength(1);
        expect(publishable[0].fields.summary).toContain("first");
    });

    it("does not mis-read fact categories or compartments as events", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="2" title="x" importance="50"><p1>a</p1><p2>b</p2><p3>c</p3><p4/></compartment>
</compartments>
<facts>
<PROJECT_RULES>
* a rule
</PROJECT_RULES>
</facts>
</output>`);
        expect(parsed.events).toEqual([]);
        expect(parsed.facts).toHaveLength(1);
    });
});

describe("parseCompartmentOutput — user_observations", () => {
    it("parses observation bullets", () => {
        const parsed = parseCompartmentOutput(`
<output>
<user_observations>
* User prefers evidence-backed root-cause analysis.
* User dislikes low-value config knobs.
</user_observations>
</output>`);
        expect(parsed.userObservations).toEqual([
            "User prefers evidence-backed root-cause analysis.",
            "User dislikes low-value config knobs.",
        ]);
    });
});

describe("parseCompartmentOutput — skill_observations", () => {
    it("parses skill observations into {skillId, kind, lesson}", () => {
        const xml = `<output>
<compartments></compartments>
<skill_observations>
* council | gotcha | aggregator needs a fast non-deficit model
* test-driven-development | fix | mock the clock in auth tests
</skill_observations>
</output>`;
        const parsed = parseCompartmentOutput(xml);
        expect(parsed.skillObservations).toEqual([
            {
                skillId: "council",
                kind: "gotcha",
                lesson: "aggregator needs a fast non-deficit model",
            },
            {
                skillId: "test-driven-development",
                kind: "fix",
                lesson: "mock the clock in auth tests",
            },
        ]);
    });

    it("absent block -> empty array", () => {
        expect(parseCompartmentOutput("<output></output>").skillObservations).toEqual([]);
    });

    it("malformed lines (bad kind, missing fields) are skipped, non-choke", () => {
        const xml = `<skill_observations>
* council | general | invalid kind dropped
* onlyskill | fix
* good | discovery | kept
</skill_observations>`;
        expect(parseCompartmentOutput(xml).skillObservations).toEqual([
            { skillId: "good", kind: "discovery", lesson: "kept" },
        ]);
    });
});

describe("parseCompartmentOutput — fact scoping (audit Fix 6)", () => {
    it("does NOT misread a category tag inside <events> as a promotable fact", () => {
        // A causal_incident's field text legitimately contains a 5-cat tag name.
        // Fact extraction must be scoped to <facts>, not the whole response.
        const parsed = parseCompartmentOutput(`
<output>
<facts>
<ARCHITECTURE>
* Real fact: storage is one SQLite DB.
</ARCHITECTURE>
</facts>
<events>
<causal_incident at_compartment="1">
<finding>The provider enforced a CONSTRAINTS-style limit we must respect.</finding>
</causal_incident>
</events>
</output>`);
        // Exactly one fact — from <facts>. The word "CONSTRAINTS" inside the
        // event field must not become a phantom CONSTRAINTS fact.
        expect(parsed.facts).toHaveLength(1);
        expect(parsed.facts[0].category).toBe("ARCHITECTURE");
        expect(parsed.facts.some((f) => f.category === "CONSTRAINTS")).toBe(false);
        expect(parsed.events).toHaveLength(1);
    });

    it("falls back to whole-text scan (minus events) when no <facts> wrapper", () => {
        // Transition/older shape: bare category blocks, no <facts> wrapper.
        const parsed = parseCompartmentOutput(`
<output>
<PROJECT_RULES>
* Use scripts/release.sh for releases.
</PROJECT_RULES>
<events>
<trajectory_correction at_compartment="1">
<from>Considered a NAMING convention change.</from>
</trajectory_correction>
</events>
</output>`);
        expect(parsed.facts).toHaveLength(1);
        expect(parsed.facts[0].category).toBe("PROJECT_RULES");
        // "NAMING" inside the event must not leak in via the fallback path.
        expect(parsed.facts.some((f) => f.category === "NAMING")).toBe(false);
    });
});
