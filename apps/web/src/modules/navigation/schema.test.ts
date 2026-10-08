import { describe, expect, it } from "vitest";
import { togglePin } from "./client/queries.ts";
import { normalizePins } from "./schema.ts";
import { availableDestinations, pinnedDestinations } from "./ui/destinations.ts";

describe("normalizePins", () => {
  it("keeps each known page once, in rail order, and drops unknown ones", () => {
    expect(normalizePins(["skills", "removed-page", "agents", "skills"])).toEqual([
      "agents",
      "skills",
    ]);
  });
});

describe("togglePin", () => {
  it("puts a new pin in its rail place and removes an existing one", () => {
    expect(togglePin(["projects", "skills"], "agents")).toEqual(["projects", "agents", "skills"]);
    expect(togglePin(["projects", "agents", "skills"], "agents")).toEqual(["projects", "skills"]);
  });
});

describe("destinations", () => {
  const everything = {
    projectsUse: true,
    agentsUse: true,
    knowledgeUse: true,
    schedules: true,
    skillsUse: true,
  };

  it("offers only pages the person may open, with chats always there", () => {
    expect(availableDestinations({ agentsUse: true }).map((each) => each.id)).toEqual([
      "agents",
      "chats",
    ]);
    expect(availableDestinations(undefined).map((each) => each.id)).toEqual(["chats"]);
  });

  it("shows pins in rail order and hides one whose page is out of reach", () => {
    expect(
      pinnedDestinations(["schedules", "projects"], everything).map((each) => each.id),
    ).toEqual(["projects", "schedules"]);
    expect(
      pinnedDestinations(["schedules", "projects"], { ...everything, schedules: false }).map(
        (each) => each.id,
      ),
    ).toEqual(["projects"]);
  });
});
