import type { MissionSource } from "./types";

export const NEON_TOWER: MissionSource = {
  id: "neon-tower-01",
  type: "assassination",
  name: "Neon Tower: Board Seat",
  brief:
    "Arasaka-Vance's CFO is closing a merger tonight. Eliminate her before the ink dries, then extract via the east service lift.",
  ascii: `
##############################
#AA.........#.......c.......E#
#AA.........#.......c.......E#
#...cc......#...1........1...#
#...........#................#
#.......2...######..##########
#............................#
#....2......c.......c........#
#######..######.........3....#
#.........#.....######.......#
#.........#.....#....#...3...#
#....4....#.....#..T.#.......#
#.........#.....#....#.......#
#.......4.......##..##.......#
#..c......#..................#
#..c......#.....5........5...#
##############################
`,
};
