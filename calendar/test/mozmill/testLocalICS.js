/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var calUtils = require("./shared-modules/calendar-utils");
var modalDialog = require("./shared-modules/modal-dialog");
Components.utils.import("resource://calendar/modules/calUtils.jsm");

const sleep = 500;
var hour = 8;
var calendar;
var uri;
var file;
var title;

var setupModule = function(module) {
  controller = mozmill.getMail3PaneController();
  
  // unique name needed as deleting a calendar only unsubscribes from it
  // and if same file were used on next testrun then previously created event would show up
  let time = (new Date()).getTime() + '';
  calendar = time;
  title = time;
  
  file = Components.classes["@mozilla.org/file/directory_service;1"]
                   .getService(Components.interfaces.nsIProperties)
                   .get("TmpD", Components.interfaces.nsIFile);
  file.append(calendar + ".ics");
  let fileURI = cal.getIOService().newFileURI(file);
  uri = fileURI.prePath + fileURI.path;
}

var testLocalICS = function () {
  controller.click(new elementslib.ID(controller.window.document,"calendar-tab-button"));
  calUtils.switchToView(controller, "day");
  
  let md = new modalDialog.modalDialog(controller.window);
  md.start(handleNewCalendarWizard);
  controller.mainMenu.click("#ltnNewCalendar");
  controller.sleep(sleep);
  
  // create new event
  controller.doubleClick(new elementslib.Lookup(controller.window.document,
    calUtils.getEventBoxPath(controller, "day", calUtils.CANVAS_BOX, undefined, 1, hour)), 1, 1);
  controller.waitFor(function() {return mozmill.utils.getWindows("Calendar:EventDialog").length > 0}, sleep);
  let event = new mozmill.controller.MozMillController(mozmill.utils
    .getWindows("Calendar:EventDialog")[0]);
  
  // title
  let titleTextBox = new elementslib.Lookup(event.window.document, '/id("calendar-event-dialog")/'
    + 'id("event-grid")/id("event-grid-rows")/id("event-grid-title-row")/'
    + 'id("item-title")/anon({"class":"textbox-input-box"})/anon({"anonid":"input"})');
  event.waitForElement(titleTextBox);
  event.type(titleTextBox, title);
  
  // set calendar
  event.select(new elementslib.ID(event.window.document, "item-calendar"), undefined,
    calendar);
  
  // save
  event.click(new elementslib.ID(event.window.document, "button-save"));
  
  // assert presence in view
  let box = calUtils.getEventBoxPath(controller, "day", calUtils.EVENT_BOX, undefined, 1, hour)
    + '/{"tooltip":"itemTooltip","calendar":"' + calendar + '"}';
  controller.waitForElement(new elementslib.Lookup(controller.window.document, box));
  
  // verify in file
  let contents = "";
  let fstream = Components.classes["@mozilla.org/network/file-input-stream;1"]
                          .createInstance(Components.interfaces.nsIFileInputStream);
  let cstream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
                          .createInstance(Components.interfaces.nsIConverterInputStream);
  
  fstream.init(file, -1, 0, 0);
  cstream.init(fstream, "UTF-8", 0, 0);
  
  let (str = {}) {
    cstream.readString(-1, str);
    contents = str.value;
  }
  
  cstream.close();
  controller.assertJS(contents.indexOf("SUMMARY:" + title) != -1);
}

var teardownTest = function(module) {
  calUtils.deleteCalendars(controller, calendar);
}

function handleNewCalendarWizard(wizard) {
  let buttonDeck = '/id("calendar-wizard")/anon({"anonid":"Buttons"})/'
    + 'anon({"class":"wizard-buttons-box-1"})/{"class":"wizard-buttons-box-2"}/'
    + 'anon({"anonid":"WizardButtonDeck"})';
  let nextButton = buttonDeck + '/[1]/{"dlgtype":"next"}';
  let finishButton = buttonDeck + '/[0]/{"dlgtype":"finish"}';
  
  // choose network calendar
  let remoteOption = new elementslib.Lookup(wizard.window.document, '/id("calendar-wizard")/'
    + '{"pageid":"initialPage"}/id("calendar-type")/{"value":"remote"}');
  wizard.waitForElement(remoteOption);
  wizard.radio(remoteOption);
  wizard.click(new elementslib.Lookup(wizard.window.document, nextButton));
  
  // choose ical
  let icalOption = new elementslib.Lookup(wizard.window.document, '/id("calendar-wizard")/'
    + '{"pageid":"locationPage"}/[1]/[1]/[0]/id("calendar-format")/{"value":"ics"}');
  wizard.waitForElement(icalOption);
  wizard.radio(icalOption);
  // enter location
  wizard.type(new elementslib.Lookup(wizard.window.document, '/id("calendar-wizard")/'
    + '{"pageid":"locationPage"}/[1]/[1]/{"align":"center"}/id("calendar-uri")/'
    + 'anon({"class":"textbox-input-box"})/anon({"anonid":"input"})'),
    uri);
  wizard.click(new elementslib.Lookup(wizard.window.document, nextButton));
  
  // name is filled in automatically using filename
  wizard.waitFor(function() {return (new elementslib.Lookup(wizard.window.document, nextButton))
                                                    .getNode().disabled == false});
  wizard.click(new elementslib.Lookup(wizard.window.document, nextButton));
  
  // finish
  wizard.waitThenClick(new elementslib.Lookup(wizard.window.document, finishButton));
}
