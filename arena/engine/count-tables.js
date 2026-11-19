// Pitch and batted-ball counts by ball-strike count, tallied from Retrosheet 2025 MLB event files
// with tools/retrosheet-count-tables.py (182926 plate appearances).
// The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".
// These are the assumed base rates of the pitch engine until licensed KBO count data replaces them.

export const COUNT_TABLE_SOURCE = {"name":"Retrosheet 2025 MLB regular season","plateAppearances":182926,"notice":"The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at \"www.retrosheet.org\"."};

// [ball, called strike, swinging strike, foul, in play, hit by pitch]
export const PITCH_OUTCOMES = ["ball","called_strike","swinging_strike","foul","in_play","hbp"];
export const PITCH_COUNTS = {
  '0-0': [69338, 54639, 15409, 22022, 21082, 436],
  '0-1': [36782, 9745, 12545, 16627, 16103, 268],
  '0-2': [22109, 1598, 6727, 8904, 8273, 191],
  '1-0': [23706, 15997, 7559, 11010, 10933, 133],
  '1-1': [24412, 7735, 10061, 14601, 14316, 223],
  '1-2': [26941, 2665, 10510, 15097, 14125, 243],
  '2-0': [7676, 6491, 2122, 3642, 3739, 36],
  '2-1': [10577, 4607, 4940, 8154, 8298, 91],
  '2-2': [18270, 2822, 9044, 14794, 14297, 195],
  '3-0': [3016, 4062, 110, 220, 262, 6],
  '3-1': [4201, 2678, 1581, 3227, 3263, 19],
  '3-2': [8161, 2303, 4910, 10083, 10282, 87],
};

// Balls in play: [1B, 2B, 3B, HR, out, double play, error/fielder's choice, sacrifice fly, sacrifice bunt]
export const IN_PLAY_OUTCOMES = ["1B","2B","3B","HR","OUT","DP","ROE_FC","SAC_FLY","SAC_BUNT"];
export const IN_PLAY_COUNTS = {
  '0-0': [4345, 1352, 114, 1113, 12714, 595, 309, 250, 290],
  '0-1': [3442, 957, 67, 609, 10106, 478, 227, 156, 61],
  '0-2': [1821, 471, 39, 240, 5271, 213, 128, 86, 4],
  '1-0': [2201, 737, 51, 616, 6759, 271, 132, 105, 61],
  '1-1': [3043, 916, 67, 605, 8910, 376, 207, 140, 52],
  '1-2': [3106, 727, 64, 470, 9067, 361, 202, 124, 4],
  '2-0': [692, 282, 26, 250, 2294, 84, 48, 48, 15],
  '2-1': [1697, 540, 48, 409, 5220, 171, 118, 83, 12],
  '2-2': [2996, 861, 69, 527, 9194, 311, 198, 140, 1],
  '3-0': [45, 20, 1, 33, 146, 5, 6, 5, 1],
  '3-1': [638, 247, 22, 216, 1973, 71, 34, 57, 5],
  '3-2': [2089, 635, 60, 562, 6511, 186, 128, 110, 1],
};

// Bunt attempts: foul bunts (L), missed bunts (M) and bunts in play, and how bunts in play ended.
export const BUNT_ATTEMPTS = { foul: 1245, missed: 241, inPlay: 1282 };
export const BUNT_IN_PLAY = { sacrifice: 507, hit: 341, out: 343, fieldersChoice: 91 };

// Outs in play with a runner on third and fewer than two outs (double plays excluded), from the
// same Retrosheet 2025 files with tools/retrosheet-runner-on-third.py (base-out state followed
// play by play; 99.5% of half-innings ended with exactly three outs).
// Type of out (count) and how often the runner from third scored on it.
export const RUNNER_ON_THIRD_OUTS = {
  outfieldAir: { outs: 1564, scored: 1294 }, // fly or line drive caught by an outfielder: sacrifice fly
  infieldAir: { outs: 533, scored: 4 },      // infield fly, pop-up or line drive
  ground: { outs: 1175, scored: 763 },       // ground out: run scores on the play
};
