export const BASE_WIDTH = 1440;
export const BASE_HEIGHT = 1024;

export const initialNodes = [
  { id: "root", x: 390, y: 488, r: 126, lines: ["An AI-assisted", "space that makes", "thinking visible"], meta: "00:18" },
  { id: "structure", x: 435, y: 238, r: 56, lines: ["Thought", "becomes", "structure"] },
  { id: "surface", x: 570, y: 132, r: 43, lines: ["Surface", "what matters"] },
  { id: "patterns", x: 650, y: 220, r: 41, lines: ["Reveal", "hidden", "patterns"] },
  { id: "connections", x: 558, y: 276, r: 44, lines: ["Make", "connections", "effortless"] },
  { id: "voice", x: 730, y: 365, r: 62, lines: ["Natural", "voice-first", "ideation"] },
  { id: "speak", x: 850, y: 260, r: 37, lines: ["Speak", "freely"] },
  { id: "capture", x: 920, y: 350, r: 44, lines: ["Capture", "every nuance"] },
  { id: "flow", x: 1080, y: 232, r: 48, lines: ["Flow", "like", "thinking"] },
  { id: "friction", x: 1198, y: 145, r: 34, lines: ["No friction"] },
  { id: "zone", x: 1195, y: 252, r: 35, lines: ["Stay in", "the zone"] },
  { id: "ai", x: 912, y: 500, r: 76, lines: ["AI as creative", "partner"] },
  { id: "ask", x: 1088, y: 390, r: 38, lines: ["Ask", "anything"] },
  { id: "suggest", x: 1165, y: 472, r: 44, lines: ["Get", "smart", "suggestions"] },
  { id: "challenge", x: 1190, y: 590, r: 45, lines: ["Challenge", "assumptions"] },
  { id: "broaden", x: 1312, y: 570, r: 37, lines: ["Broaden", "perspectives"] },
  { id: "stress", x: 1242, y: 690, r: 35, lines: ["Stress-test", "ideas"] },
  { id: "organize", x: 694, y: 624, r: 64, lines: ["Organize", "without", "overthinking"] },
  { id: "emerge", x: 855, y: 675, r: 38, lines: ["Let structure", "emerge"] },
  { id: "context", x: 805, y: 770, r: 40, lines: ["Keep context", "as you grow"] },
  { id: "flexible", x: 948, y: 762, r: 39, lines: ["Flexible,", "not rigid"] },
  { id: "evolve", x: 926, y: 872, r: 40, lines: ["Adapt as", "ideas evolve"] },
  { id: "private", x: 405, y: 778, r: 58, lines: ["Private &", "focused", "by default"] },
  { id: "yours", x: 535, y: 700, r: 38, lines: ["Your ideas", "stay yours"] },
  { id: "calm", x: 526, y: 835, r: 37, lines: ["A calm space", "to think"] },
  { id: "zoom", x: 658, y: 742, r: 40, lines: ["Zoom in", "with ease"] },
  { id: "ghost-left", x: 200, y: 665, r: 54, lines: ["AI helps you", "find the next", "step"], ghost: true },
  { id: "ghost-top", x: 960, y: 115, r: 50, lines: ["AI suggests", "what you", "might miss"], ghost: true },
  { id: "ghost-right", x: 1098, y: 700, r: 51, lines: ["What if we", "looked at it", "this way?"], ghost: true },
];

export const initialEdges = [
  ["root", "structure"], ["structure", "surface"], ["structure", "connections"], ["structure", "patterns"],
  ["root", "voice"], ["voice", "speak"], ["voice", "capture"], ["capture", "flow"], ["flow", "friction"], ["flow", "zone"],
  ["root", "ai"], ["ai", "ask"], ["ai", "suggest"], ["suggest", "challenge"], ["challenge", "broaden"], ["challenge", "stress"],
  ["root", "organize"], ["organize", "emerge"], ["organize", "context"], ["organize", "flexible"], ["flexible", "evolve"],
  ["root", "private"], ["private", "yours"], ["private", "calm"], ["organize", "zoom"],
  ["root", "ghost-left"], ["flow", "ghost-top"], ["challenge", "ghost-right"],
];

