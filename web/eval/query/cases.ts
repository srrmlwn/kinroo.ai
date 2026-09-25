// Questions about the calendar in ./dataset.ts, each with what a correct
// answer contains. Event ids are the dataset's ids (e.g. "sahana-hh-0927").
//
// expect:
//   { events: [...] }           exactly these events
//   { oneOf: [[...], [...]] }   any one of these event sets (genuinely
//                               ambiguous questions, e.g. whether an all-day
//                               reminder counts as "Sunday morning")
//   { next: "sahana-hh" }       at least the next occurrence of that weekly
//                               series, and nothing outside the series —
//                               "when is X" may fairly list upcoming ones too
// yesNo: for a yes/no question, the "Yes."/"No." the answer must lead with.

export type Expectation = { events: string[] } | { oneOf: string[][] } | { next: string };

export interface QueryCase {
  group: string;
  question: string;
  expect: Expectation;
  yesNo?: "yes" | "no";
}

export const CASES: QueryCase[] = [
  // A specific event, by name
  { group: "named event", question: "When is Sahana's hippity hop?", expect: { next: "sahana-hh" } },
  { group: "named event", question: "When is Sasha's gymnastics?", expect: { next: "sasha-gym" } },
  { group: "named event", question: "What time is ninja this week?", expect: { events: ["sahana-ninja-0930"] } },
  { group: "named event", question: "When is Sahana's next gymnastics class?", expect: { events: ["sahana-gym-0925"] } },
  { group: "named event", question: "When does Step One Foods ship?", expect: { events: ["stepone-0927"] } },
  {
    group: "named event",
    question: "When is hippity hop this weekend?",
    expect: { events: ["sasha-hh-0926", "sahana-hh-0927"] },
  },

  // Synonyms and typos
  { group: "wording", question: "When is Sahana's gym?", expect: { next: "sahana-gym" } },
  { group: "wording", question: "When is swimming?", expect: { next: "sahana-swim" } },
  {
    group: "wording",
    question: "When is hipity hop this weekend?",
    expect: { events: ["sasha-hh-0926", "sahana-hh-0927"] },
  },
  { group: "wording", question: "when's sahanas ninja", expect: { next: "sahana-ninja" } },

  // The right activity, the wrong person
  { group: "wrong person", question: "When is Sasha's swim?", expect: { events: [] } },
  { group: "wrong person", question: "When is Sasha's ninja class?", expect: { events: [] } },
  {
    group: "wrong person",
    question: "Does Sahana have gymnastics on Sunday?",
    expect: { events: [] },
    yesNo: "no",
  },

  // Everything for one person
  {
    group: "one person",
    question: "What does Sahana have in the next 7 days?",
    expect: { events: ["sahana-gym-0925", "sahana-hh-0927", "sahana-swim-0928", "sahana-ninja-0930"] },
  },
  {
    group: "one person",
    question: "What's on Sasha's schedule this weekend?",
    expect: { events: ["sasha-hh-0926", "sasha-gym-0927"] },
  },
  { group: "one person", question: "What does Sahana have on Sunday?", expect: { events: ["sahana-hh-0927"] } },
  { group: "one person", question: "Does Sasha have anything Monday?", expect: { events: [] }, yesNo: "no" },

  // Location
  { group: "location", question: "Where is Sahana's ninja class?", expect: { next: "sahana-ninja" } },
  {
    group: "location",
    question: "What's happening at Ballard Academy of Music and Dance this weekend?",
    expect: { events: ["sasha-hh-0926", "sahana-hh-0927"] },
  },
  { group: "location", question: "Anything at Discover Gymnastics next week?", expect: { events: ["sahana-ninja-0930"] } },
  { group: "location", question: "What's coming up at Seattle Gymnastics Academy?", expect: { next: "sahana-gym" } },

  // Dates and times
  { group: "dates", question: "What's on today?", expect: { events: ["sahana-gym-0925"] } },
  {
    group: "dates",
    question: "What do I have Sunday?",
    expect: { events: ["stepone-0927", "sasha-gym-0927", "sahana-hh-0927"] },
  },
  {
    group: "dates",
    question: "What plans do I have this weekend?",
    expect: { events: ["sasha-hh-0926", "stepone-0927", "sasha-gym-0927", "sahana-hh-0927"] },
  },
  { group: "dates", question: "Anything on Tuesday?", expect: { events: [] } },
  {
    group: "dates",
    question: "What's on Sunday morning?",
    expect: {
      oneOf: [
        ["sasha-gym-0927", "sahana-hh-0927"],
        ["stepone-0927", "sasha-gym-0927", "sahana-hh-0927"],
      ],
    },
  },
  {
    group: "dates",
    question: "What evening activities do we have before Tuesday?",
    expect: { events: ["sahana-gym-0925", "sahana-swim-0928"] },
  },
  { group: "dates", question: "What's on the calendar for October 3rd?", expect: { events: ["sasha-hh-1003"] } },

  // Am I free?
  {
    group: "free/busy",
    question: "Am I free Sunday morning?",
    expect: {
      oneOf: [
        ["sasha-gym-0927", "sahana-hh-0927"],
        ["stepone-0927", "sasha-gym-0927", "sahana-hh-0927"],
      ],
    },
    yesNo: "no",
  },
  { group: "free/busy", question: "Am I free Saturday afternoon?", expect: { events: [] }, yesNo: "yes" },
  { group: "free/busy", question: "Is anything scheduled Tuesday?", expect: { events: [] }, yesNo: "no" },

  // Counting and order
  {
    group: "count/order",
    question: "How many events are on Sunday?",
    expect: { events: ["stepone-0927", "sasha-gym-0927", "sahana-hh-0927"] },
  },
  {
    group: "count/order",
    question: "What's my first thing Sunday morning?",
    expect: { oneOf: [["sasha-gym-0927"], ["stepone-0927"]] },
  },
  { group: "count/order", question: "What's next?", expect: { events: ["sahana-gym-0925"] } },
  {
    group: "count/order",
    question: "What comes after Sasha's gymnastics on Sunday?",
    expect: { events: ["sahana-hh-0927"] },
  },

  // Type of activity
  {
    group: "activity type",
    question: "When are the kids' dance classes this weekend?",
    expect: { events: ["sasha-hh-0926", "sahana-hh-0927"] },
  },
  {
    group: "activity type",
    question: "What sports does Sahana have next week?",
    expect: { events: ["sahana-swim-0928", "sahana-ninja-0930", "sahana-gym-1002"] },
  },
  { group: "activity type", question: "Any deliveries coming?", expect: { events: ["stepone-0927"] } },

  // Recurrence and misses
  { group: "recurrence/miss", question: "How often is Sahana's gymnastics?", expect: { next: "sahana-gym" } },
  { group: "recurrence/miss", question: "When is the dentist?", expect: { events: [] } },
];
