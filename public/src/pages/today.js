import { wireAuth } from "../auth.js";
import { initDayView } from "../day-view.js";
import { wireEndDay, wireRestore, ensureEmptyDay } from "../endday.js";
import { processDrawerForDate, wireDrawerModal, refreshDrawerBadge } from "../drawer.js";
import { getPlannerDate, ymd } from "../storage.js";

wireAuth();
initDayView(0);

wireEndDay();
wireRestore();
ensureEmptyDay(1);

wireDrawerModal();
processDrawerForDate(ymd(getPlannerDate(0)));
refreshDrawerBadge();
