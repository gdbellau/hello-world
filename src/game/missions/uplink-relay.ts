import type { MissionSource } from "./types";

export const UPLINK_RELAY: MissionSource = {
  id: "uplink-relay-05",
  type: "espionage",
  name: "Uplink Relay 7",
  brief:
    "Orbital Dynamics routes every board-level call through a relay station bolted to the Sprawl's old weather tower. Tap all four junction terminals and we hear their next quarter before they do. The relay is wired with locked bulkheads and a hall turret. Keep it quiet.",
  ascii: `
############################
#AA....#..........#.......R#
#AA....#...1..H...#..V.....#
#......D..........D........#
#..cc..#....cc....#..H..2..#
#......#..........#........#
#..1...########.###....c...#
#EE................c...c...#
#EE...V..........U.........#
#EE................c...c...#
#......####D#########.######
#..3...#.........#.........#
#......#..cc..cc.#....3....#
#..cc..#....H....D.........#
#......#..cc..cc.#...cc....#
#..K...#.........#.....H...#
#......#..4...4..#.........#
#R.....#.........#.........#
############################
`,
};
