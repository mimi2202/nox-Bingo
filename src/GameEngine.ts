import { BingoCard, BingoCell } from './types';

const B_COL = { min: 1, max: 15 };
const I_COL = { min: 16, max: 30 };
const N_COL = { min: 31, max: 45 };
const G_COL = { min: 46, max: 60 };
const O_COL = { min: 61, max: 75 };

function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function generateColumnNumbers(min: number, max: number): number[] {
  const numbers: number[] = [];
  for (let i = min; i <= max; i++) numbers.push(i);
  return shuffle(numbers).slice(0, 5);
}

function pickNoxCell(): { row: number; col: number } {
  let row: number, col: number;
  do {
    row = Math.floor(Math.random() * 5);
    col = Math.floor(Math.random() * 5);
  } while (row === 2 && col === 2);
  return { row, col };
}

export function generateCards(seed: string): BingoCard[] {
  const cards: BingoCard[] = [];
  for (let i = 0; i < 3; i++) {
    const bCol = generateColumnNumbers(B_COL.min, B_COL.max);
    const iCol = generateColumnNumbers(I_COL.min, I_COL.max);
    const nCol = generateColumnNumbers(N_COL.min, N_COL.max);
    const gCol = generateColumnNumbers(G_COL.min, G_COL.max);
    const oCol = generateColumnNumbers(O_COL.min, O_COL.max);

    const grid: BingoCell[][] = [];
    for (let row = 0; row < 5; row++) {
      const rowCells: BingoCell[] = [];
      for (let col = 0; col < 5; col++) {
        const isFreeSpace = row === 2 && col === 2;
        let value: number | 'FREE';
        if (isFreeSpace) {
          value = 'FREE';
        } else if (col === 0) value = bCol[row];
        else if (col === 1) value = iCol[row];
        else if (col === 2) value = nCol[row];
        else if (col === 3) value = gCol[row];
        else value = oCol[row];

        rowCells.push({ value, marked: isFreeSpace, isFreeSpace });
      }
      grid.push(rowCells);
    }

    cards.push({
      id: 'card-' + i,
      grid,
      noxCell: pickNoxCell(),
      noxHit: false,
    });
  }
  return cards;
}

export function generateDrawSequence(seed: string): number[] {
  const balls: number[] = [];
  for (let i = 1; i <= 75; i++) balls.push(i);
  return shuffle(balls);
}

export function checkForWin(cards: BingoCard[]): number | null {
  for (let i = 0; i < cards.length; i++) {
    if (hasWinningLine(cards[i])) return i;
  }
  return null;
}

function hasWinningLine(card: BingoCard): boolean {
  for (let row = 0; row < 5; row++) {
    if (card.grid[row].every(cell => cell.marked)) return true;
  }
  for (let col = 0; col < 5; col++) {
    let complete = true;
    for (let row = 0; row < 5; row++) {
      if (!card.grid[row][col].marked) {
        complete = false;
        break;
      }
    }
    if (complete) return true;
  }
  return false;
}

export function autoDaub(cards: BingoCard[], number: number): BingoCard[] {
  return cards.map(card => {
    const newGrid = card.grid.map(row =>
      row.map(cell => {
        if (cell.value === number && !cell.marked) {
          return { ...cell, marked: true };
        }
        return cell;
      })
    );
    return { ...card, grid: newGrid };
  });
}

export function getNearMissCount(card: BingoCard): number {
  let minMissing = Infinity;
  for (let row = 0; row < 5; row++) {
    let missing = 0;
    for (let col = 0; col < 5; col++) {
      if (!card.grid[row][col].marked && card.grid[row][col].value !== 'FREE') missing++;
    }
    minMissing = Math.min(minMissing, missing);
  }
  for (let col = 0; col < 5; col++) {
    let missing = 0;
    for (let row = 0; row < 5; row++) {
      if (!card.grid[row][col].marked && card.grid[row][col].value !== 'FREE') missing++;
    }
    minMissing = Math.min(minMissing, missing);
  }
  return minMissing;
}

export function getLetterForNumber(num: number): string {
  if (num <= 15) return 'B';
  if (num <= 30) return 'I';
  if (num <= 45) return 'N';
  if (num <= 60) return 'G';
  return 'O';
}
