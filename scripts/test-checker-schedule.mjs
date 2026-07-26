import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/timeline/background/background.js', 'utf8');
const start = source.indexOf('function checkerNumber(');
const end = source.indexOf('chrome.alarms.onAlarm.addListener(', start);
assert.ok(start >= 0 && end > start, 'checker scheduling helpers should be present');

const RealDate = Date;
let currentNow = new RealDate(2027, 0, 31, 12, 0, 0, 0);
class FakeDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [currentNow.getTime()]));
  }

  static now() {
    return currentNow.getTime();
  }
}

const settings = {
  checkerFrequency: 'monthly',
  checkerTime: '03:00',
  checkerDayOfWeek: 1,
  checkerDayOfMonth: 31,
};
const created = [];
const cleared = [];
let existingAlarms = [];
const context = {
  Array,
  Date: FakeDate,
  Math,
  Number,
  Object,
  Promise,
  CHECKER_ALARM_PREFIX: 'bookmark_checker_',
  chrome: {
    alarms: {
      getAll: async () => existingAlarms,
      clear: async (name) => { cleared.push(name); return true; },
      create: async (name, options) => created.push({ name, options }),
    },
    storage: {
      local: {
        get: async () => ({ ...settings }),
        set: async () => undefined,
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}; this.scheduleCheckerAlarm = scheduleCheckerAlarm;`, context);

await context.scheduleCheckerAlarm();
assert.equal(created.length, 1);
assert.equal(created[0].name, 'bookmark_checker_monthly');
assert.equal(
  currentNow.getTime() + created[0].options.delayInMinutes * 60_000,
  new RealDate(2027, 1, 28, 3, 0, 0, 0).getTime(),
  'a January 31 schedule must target the last valid day of February',
);
assert.equal(
  Object.hasOwn(created[0].options, 'periodInMinutes'),
  false,
  'monthly checks must use a one-shot alarm instead of a drifting 30-day period',
);

currentNow = new RealDate(2028, 0, 31, 12, 0, 0, 0);
created.length = 0;
await context.scheduleCheckerAlarm();
assert.equal(
  currentNow.getTime() + created[0].options.delayInMinutes * 60_000,
  new RealDate(2028, 1, 29, 3, 0, 0, 0).getTime(),
  'a leap-year January 31 schedule must target February 29',
);

currentNow = new RealDate(2027, 0, 31, 12, 0, 0, 0);
created.length = 0;
settings.checkerFrequency = 'daily';
await context.scheduleCheckerAlarm();
assert.equal(created[0].options.periodInMinutes, 24 * 60);

created.length = 0;
settings.checkerTime = '99:99';
await context.scheduleCheckerAlarm();
assert.equal(
  currentNow.getTime() + created[0].options.delayInMinutes * 60_000,
  new RealDate(2027, 1, 1, 3, 0, 0, 0).getTime(),
  'invalid persisted times must fall back to 03:00',
);

currentNow = new RealDate(2027, 0, 31, 3, 0, 31, 0);
created.length = 0;
settings.checkerTime = '03:02';
await context.scheduleCheckerAlarm();
assert.equal(created[0].options.delayInMinutes, 2, 'checker alarms must never fire before the configured minute');

currentNow = new RealDate(2027, 0, 31, 12, 0, 0, 0);
created.length = 0;
settings.checkerFrequency = 'weekly';
settings.checkerTime = '03:00';
await context.scheduleCheckerAlarm();
assert.equal(created[0].options.periodInMinutes, 7 * 24 * 60);

created.length = 0;
cleared.length = 0;
existingAlarms = [{ name: 'bookmark_checker_daily' }, { name: 'rss_poll' }];
settings.checkerFrequency = 'never';
await context.scheduleCheckerAlarm();
assert.deepEqual(cleared, ['bookmark_checker_daily']);
assert.equal(created.length, 0, 'disabled scheduling must only clear existing checker alarms');

assert.match(
  source,
  /alarm\.name === CHECKER_ALARM_PREFIX \+ 'monthly'[\s\S]{0,200}scheduleCheckerAlarm\(\)/,
  'the one-shot monthly alarm must schedule the following natural month when it fires',
);

console.log('checker scheduling tests passed');
