import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtCur, setLang, setSymbol, t } from '../src/i18n.ts';
import type { Key } from '../src/i18n.ts';

const plain = (s: string): string => s.replace(/ /g, ' ');

test('chiave mancante: ripiega sulla chiave stessa, la lingua scelta non rompe i testi noti', () => {
  setLang('en');
  assert.equal(t('nessuna.chiave' as Key), 'nessuna.chiave');
  assert.equal(t('res.sub'), 'Subtotal');
  setLang('it');
  assert.equal(t('res.sub'), 'Subtotale');
});

test('valuta IT: simbolo dopo, virgola decimale', () => {
  setLang('it'); setSymbol('€');
  assert.equal(plain(fmtCur(12345.5)), '12.345,50 €');
});

test('valuta EN: simbolo prima, punto decimale; simbolo personalizzato', () => {
  setLang('en'); setSymbol('€');
  assert.equal(plain(fmtCur(12345.5)), '€12,345.50');
  setSymbol('CHF');
  assert.equal(plain(fmtCur(2)), 'CHF2.00');
  setLang('it'); setSymbol('€');
});
