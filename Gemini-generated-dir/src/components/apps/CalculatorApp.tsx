import React, { useState } from 'react';
import { Calculator } from 'lucide-react';

const evaluateExpression = (input: string): number => {
  const tokens = input.match(/\d+(?:\.\d*)?|\.\d+|[()+*/-]/g) ?? [];
  if (tokens.join('') !== input.replace(/\s/g, '')) {
    throw new Error('Only numbers and + − × ÷ parentheses are supported.');
  }
  let position = 0;

  const parseFactor = (): number => {
    const token = tokens[position++];
    if (token === '+') return parseFactor();
    if (token === '-') return -parseFactor();
    if (token === '(') {
      const value = parseExpression();
      if (tokens[position++] !== ')') throw new Error('Missing closing parenthesis.');
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error('Enter a valid expression.');
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++];
      const right = parseFactor();
      if (operator === '/' && right === 0) throw new Error('Cannot divide by zero.');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };

  if (!tokens.length) throw new Error('Enter an expression.');
  const result = parseExpression();
  if (position !== tokens.length || !Number.isFinite(result)) throw new Error('Enter a valid expression.');
  return result;
};

export const CalculatorApp: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [display, setDisplay] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const press = (key: string) => {
    setError(null);
    if (key === 'C') {
      setExpression('');
      setDisplay('0');
    } else if (key === '⌫') {
      setExpression((value) => value.slice(0, -1));
      setDisplay((value) => value.slice(0, -1) || '0');
    } else if (key === '=') {
      try {
        const result = evaluateExpression(expression);
        setDisplay(String(Number(result.toPrecision(12))));
        setExpression(String(Number(result.toPrecision(12))));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } else {
      setExpression((value) => value + key);
      setDisplay((value) => value === '0' && /\d/.test(key) ? key : value + key);
    }
  };

  const keys = ['C', '(', ')', '⌫', '7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+'];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#111722] p-5 text-slate-100">
      <div className="flex w-full max-w-sm items-center gap-2 text-sm font-semibold text-slate-200">
        <Calculator className="h-5 w-5 text-blue-300" /> Calculator
      </div>
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#171e2b] p-4">
        <div className="min-h-5 break-all text-right text-xs text-slate-400">{expression || ' '}</div>
        <output aria-live="polite" className="block min-h-12 break-all py-2 text-right text-3xl font-light">{display}</output>
        {error && <p role="alert" className="pb-2 text-right text-xs text-red-300">{error}</p>}
        <div className="grid grid-cols-4 gap-2">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              aria-label={key === '⌫' ? 'Backspace' : key}
              className={`flex h-12 items-center justify-center rounded-lg border border-white/5 text-sm transition-colors ${
                key === '=' ? 'bg-blue-600 font-semibold text-white hover:bg-blue-500'
                  : ['+', '-', '*', '/', '(', ')'].includes(key) ? 'bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25'
                    : key === 'C' || key === '⌫' ? 'bg-white/10 text-slate-200 hover:bg-white/15'
                      : 'bg-[#222a39] text-white hover:bg-[#30394b]'
              }`}
            >
              {key === '*' ? '×' : key === '/' ? '÷' : key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
