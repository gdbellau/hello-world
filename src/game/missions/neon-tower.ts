import type { MissionSource } from "./types";

export const NEON_TOWER: MissionSource = {
  id: "neon-tower-01",
  type: "assassination",
  name: "Neon Tower: Board Seat",
  targetName: "CFO M. VANCE",
  brief:
    "Arasaka-Vance's CFO is closing a merger tonight in the 88th-floor strongroom. Eliminate her before the ink dries, then extract via the east service lift. A lobby camera watches the strongroom and a turret guards her desk; the maintenance node by the south hall can blind both.",
  ascii: `
##############################
#AA...C.....#.......c......EE#
#AA.........#.......c......EE#
#...cc......#...1........1...#
#...........#................#
#...........######..##########
#...........................R#
#.....2...2.c.......c........#
#######..######.........3....#
#.........#.....######V......#
#..C......#.....#U...#...3...#
#....4....#.....#..T.#.......#
#.........#.....#....#.......#
#.......4.......##..##.......#
#..c......#.K................#
#..c......#.....5........5..R#
##############################
`,
};
