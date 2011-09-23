/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Places Unit Tests Code.
 *
 * The Initial Developer of the Original Code is the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Marco Bonardo <mak77@bonardo.net>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const NS_APP_USER_PROFILE_50_DIR = "ProfD";
const NS_APP_PROFILE_DIR_STARTUP = "ProfDS";
const NS_APP_BOOKMARKS_50_FILE = "BMarks";

// Shortcuts to transitions type.
const TRANSITION_LINK = Ci.nsINavHistoryService.TRANSITION_LINK;
const TRANSITION_TYPED = Ci.nsINavHistoryService.TRANSITION_TYPED;
const TRANSITION_BOOKMARK = Ci.nsINavHistoryService.TRANSITION_BOOKMARK;
const TRANSITION_EMBED = Ci.nsINavHistoryService.TRANSITION_EMBED;
const TRANSITION_FRAMED_LINK = Ci.nsINavHistoryService.TRANSITION_FRAMED_LINK;
const TRANSITION_REDIRECT_PERMANENT = Ci.nsINavHistoryService.TRANSITION_REDIRECT_PERMANENT;
const TRANSITION_REDIRECT_TEMPORARY = Ci.nsINavHistoryService.TRANSITION_REDIRECT_TEMPORARY;
const TRANSITION_DOWNLOAD = Ci.nsINavHistoryService.TRANSITION_DOWNLOAD;

// This error icon must stay in sync with FAVICON_ERRORPAGE_URL in
// nsIFaviconService.idl, aboutCertError.xhtml and netError.xhtml.
const FAVICON_ERRORPAGE_URL = "chrome://global/skin/icons/warning-16.png";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "Services", function() {
  Cu.import("resource://gre/modules/Services.jsm");
  return Services;
});

XPCOMUtils.defineLazyGetter(this, "NetUtil", function() {
  Cu.import("resource://gre/modules/NetUtil.jsm");
  return NetUtil;
});

XPCOMUtils.defineLazyGetter(this, "FileUtils", function() {
  Cu.import("resource://gre/modules/FileUtils.jsm");
  return FileUtils;
});

XPCOMUtils.defineLazyGetter(this, "PlacesUtils", function() {
  Cu.import("resource://gre/modules/PlacesUtils.jsm");
  return PlacesUtils;
});


function LOG(aMsg) {
  aMsg = ("*** PLACES TESTS: " + aMsg);
  Services.console.logStringMessage(aMsg);
  print(aMsg);
}


let gTestDir = do_get_cwd();

// Ensure history is enabled.
Services.prefs.setBoolPref("places.history.enabled", true);

// Initialize profile.
let gProfD = do_get_profile();

// Remove any old database.
clearDB();


/**
 * Shortcut to create a nsIURI.
 *
 * @param aSpec
 *        URLString of the uri.
 */
function uri(aSpec) NetUtil.newURI(aSpec);


/**
 * Gets the database connection.  If the Places connection is invalid it will
 * try to create a new connection.
 *
 * @return The database connection or null if unable to get one.
 */
let gDBConn;
function DBConn() {
  let db = PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase)
                              .DBConnection;
  if (db.connectionReady)
    return db;

  // If the Places database connection has been closed, create a new connection.
  if (!gDBConn) {
    let file = Services.dirsvc.get('ProfD', Ci.nsIFile);
    file.append("places.sqlite");
    gDBConn = Services.storage.openDatabase(file);

    // Be sure to cleanly close this connection.
    Services.obs.addObserver(function (aSubject, aTopic, aData) {
      Services.obs.removeObserver(arguments.callee, aTopic);
      gDBConn.asyncClose();
    }, "profile-before-change", false);
  }

  return gDBConn.connectionReady ? gDBConn : null;
};

/**
 * Reads data from the provided inputstream.
 *
 * @return an array of bytes.
 */ 
function readInputStreamData(aStream) {
  let bistream = Cc["@mozilla.org/binaryinputstream;1"].
                 createInstance(Ci.nsIBinaryInputStream);
  try {
    bistream.setInputStream(aStream);
    let expectedData = [];
    let avail;
    while (avail = bistream.available()) {
      expectedData = expectedData.concat(bistream.readByteArray(avail));
    }
    return expectedData;
  } finally {
    bistream.close();
  }
}

/**
 * Reads the data from the specified nsIFile.
 *
 * @param aFile
 *        The nsIFile to read from.
 * @return an array of bytes.
 */
function readFileData(aFile) {
  let inputStream = Cc["@mozilla.org/network/file-input-stream;1"].
                    createInstance(Ci.nsIFileInputStream);
  // init the stream as RD_ONLY, -1 == default permissions.
  inputStream.init(aFile, 0x01, -1, null);

  // Check the returned size versus the expected size.
  let size  = inputStream.available();
  let bytes = readInputStreamData(inputStream);
  if (size != bytes.length) {
    throw "Didn't read expected number of bytes";
  }
  return bytes;
}


/**
 * Compares two arrays, and returns true if they are equal.
 *
 * @param aArray1
 *        First array to compare.
 * @param aArray2
 *        Second array to compare.
 */
function compareArrays(aArray1, aArray2) {
  if (aArray1.length != aArray2.length) {
    print("compareArrays: array lengths differ\n");
    return false;
  }

  for (let i = 0; i < aArray1.length; i++) {
    if (aArray1[i] != aArray2[i]) {
      print("compareArrays: arrays differ at index " + i + ": " +
            "(" + aArray1[i] + ") != (" + aArray2[i] +")\n");
      return false;
    }
  }

  return true;
}


/**
 * Deletes a previously created sqlite file from the profile folder.
 */
function clearDB() {
  try {
    let file = Services.dirsvc.get('ProfD', Ci.nsIFile);
    file.append("places.sqlite");
    if (file.exists())
      file.remove(false);
  } catch(ex) { dump("Exception: " + ex); }
}


/**
 * Dumps the rows of a table out to the console.
 *
 * @param aName
 *        The name of the table or view to output.
 */
function dump_table(aName)
{
  let stmt = DBConn().createStatement("SELECT * FROM " + aName);

  print("\n*** Printing data from " + aName);
  let count = 0;
  while (stmt.executeStep()) {
    let columns = stmt.numEntries;

    if (count == 0) {
      // Print the column names.
      for (let i = 0; i < columns; i++)
        dump(stmt.getColumnName(i) + "\t");
      dump("\n");
    }

    // Print the rows.
    for (let i = 0; i < columns; i++) {
      switch (stmt.getTypeOfIndex(i)) {
        case Ci.mozIStorageValueArray.VALUE_TYPE_NULL:
          dump("NULL\t");
          break;
        case Ci.mozIStorageValueArray.VALUE_TYPE_INTEGER:
          dump(stmt.getInt64(i) + "\t");
          break;
        case Ci.mozIStorageValueArray.VALUE_TYPE_FLOAT:
          dump(stmt.getDouble(i) + "\t");
          break;
        case Ci.mozIStorageValueArray.VALUE_TYPE_TEXT:
          dump(stmt.getString(i) + "\t");
          break;
      }
    }
    dump("\n");

    count++;
  }
  print("*** There were a total of " + count + " rows of data.\n");

  stmt.finalize();
}


/**
 * Checks if an address is found in the database.
 * @param aURI
 *        nsIURI or address to look for.
 * @return place id of the page or 0 if not found
 */
function page_in_database(aURI)
{
  let url = aURI instanceof Ci.nsIURI ? aURI.spec : aURI;
  let stmt = DBConn().createStatement(
    "SELECT id FROM moz_places WHERE url = :url"
  );
  stmt.params.url = url;
  try {
    if (!stmt.executeStep())
      return 0;
    return stmt.getInt64(0);
  }
  finally {
    stmt.finalize();
  }
}

/**
 * Checks how many visits exist for a specified page.
 * @param aURI
 *        nsIURI or address to look for.
 * @return number of visits found.
 */
function visits_in_database(aURI)
{
  let url = aURI instanceof Ci.nsIURI ? aURI.spec : aURI;
  let stmt = DBConn().createStatement(
    "SELECT count(*) FROM moz_historyvisits v "
  + "JOIN moz_places h ON h.id = v.place_id "
  + "WHERE url = :url"
  );
  stmt.params.url = url;
  try {
    if (!stmt.executeStep())
      return 0;
    return stmt.getInt64(0);
  }
  finally {
    stmt.finalize();
  }
}

/**
 * Removes all bookmarks and checks for correct cleanup
 */
function remove_all_bookmarks() {
  let PU = PlacesUtils;
  // Clear all bookmarks
  PU.bookmarks.removeFolderChildren(PU.bookmarks.bookmarksMenuFolder);
  PU.bookmarks.removeFolderChildren(PU.bookmarks.toolbarFolder);
  PU.bookmarks.removeFolderChildren(PU.bookmarks.unfiledBookmarksFolder);
  // Check for correct cleanup
  check_no_bookmarks();
}


/**
 * Checks that we don't have any bookmark
 */
function check_no_bookmarks() {
  let query = PlacesUtils.history.getNewQuery();
  let folders = [
    PlacesUtils.bookmarks.toolbarFolder,
    PlacesUtils.bookmarks.bookmarksMenuFolder,
    PlacesUtils.bookmarks.unfiledBookmarksFolder,
  ];
  query.setFolders(folders, 3);
  let options = PlacesUtils.history.getNewQueryOptions();
  options.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_BOOKMARKS;
  let root = PlacesUtils.history.executeQuery(query, options).root;
  root.containerOpen = true;
  if (root.childCount != 0)
    do_throw("Unable to remove all bookmarks");
  root.containerOpen = false;
}



/**
 * Sets title synchronously for a page in moz_places.
 *
 * @param aURI
 *        An nsIURI to set the title for.
 * @param aTitle
 *        The title to set the page to.
 * @throws if the page is not found in the database.
 *
 * @note This is just a test compatibility mock.
 */
function setPageTitle(aURI, aTitle) {
  PlacesUtils.history.setPageTitle(aURI, aTitle);
}


/**
 * Clears history invoking callback when done.
 *
 * @param aCallback
 *        Callback function to be called once clear history has finished.
 */
function waitForClearHistory(aCallback) {
  let observer = {
    observe: function(aSubject, aTopic, aData) {
      Services.obs.removeObserver(this, PlacesUtils.TOPIC_EXPIRATION_FINISHED);
      aCallback();
    }
  };
  Services.obs.addObserver(observer, PlacesUtils.TOPIC_EXPIRATION_FINISHED, false);

  PlacesUtils.bhistory.removeAllPages();
}


/**
 * Simulates a Places shutdown.
 */
function shutdownPlaces(aKeepAliveConnection)
{
  let hs = PlacesUtils.history.QueryInterface(Ci.nsIObserver);
  hs.observe(null, "profile-change-teardown", null);
  hs.observe(null, "profile-before-change", null);
}


/**
 * Creates a bookmarks.html file in the profile folder from a given source file.
 *
 * @param aFilename
 *        Name of the file to copy to the profile folder.  This file must
 *        exist in the directory that contains the test files.
 *
 * @return nsIFile object for the file.
 */
function create_bookmarks_html(aFilename) {
  if (!aFilename)
    do_throw("you must pass a filename to create_bookmarks_html function");
  remove_bookmarks_html();
  let bookmarksHTMLFile = gTestDir.clone();
  bookmarksHTMLFile.append(aFilename);
  do_check_true(bookmarksHTMLFile.exists());
  bookmarksHTMLFile.copyTo(gProfD, FILENAME_BOOKMARKS_HTML);
  let profileBookmarksHTMLFile = gProfD.clone();
  profileBookmarksHTMLFile.append(FILENAME_BOOKMARKS_HTML);
  do_check_true(profileBookmarksHTMLFile.exists());
  return profileBookmarksHTMLFile;
}


/**
 * Remove bookmarks.html file from the profile folder.
 */
function remove_bookmarks_html() {
  let profileBookmarksHTMLFile = gProfD.clone();
  profileBookmarksHTMLFile.append(FILENAME_BOOKMARKS_HTML);
  if (profileBookmarksHTMLFile.exists()) {
    profileBookmarksHTMLFile.remove(false);
    do_check_false(profileBookmarksHTMLFile.exists());
  }
}


/**
 * Check bookmarks.html file exists in the profile folder.
 *
 * @return nsIFile object for the file.
 */
function check_bookmarks_html() {
  let profileBookmarksHTMLFile = gProfD.clone();
  profileBookmarksHTMLFile.append(FILENAME_BOOKMARKS_HTML);
  do_check_true(profileBookmarksHTMLFile.exists());
  return profileBookmarksHTMLFile;
}


/**
 * Creates a JSON backup in the profile folder folder from a given source file.
 *
 * @param aFilename
 *        Name of the file to copy to the profile folder.  This file must
 *        exist in the directory that contains the test files.
 *
 * @return nsIFile object for the file.
 */
function create_JSON_backup(aFilename) {
  if (!aFilename)
    do_throw("you must pass a filename to create_JSON_backup function");
  remove_all_JSON_backups();
  let bookmarksBackupDir = gProfD.clone();
  bookmarksBackupDir.append("bookmarkbackups");
  if (!bookmarksBackupDir.exists()) {
    bookmarksBackupDir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("0755"));
    do_check_true(bookmarksBackupDir.exists());
  }
  let bookmarksJSONFile = gTestDir.clone();
  bookmarksJSONFile.append(aFilename);
  do_check_true(bookmarksJSONFile.exists());
  bookmarksJSONFile.copyTo(bookmarksBackupDir, FILENAME_BOOKMARKS_JSON);
  let profileBookmarksJSONFile = bookmarksBackupDir.clone();
  profileBookmarksJSONFile.append(FILENAME_BOOKMARKS_JSON);
  do_check_true(profileBookmarksJSONFile.exists());
  return profileBookmarksJSONFile;
}


/**
 * Remove bookmarksbackup dir and all backups from the profile folder.
 */
function remove_all_JSON_backups() {
  let bookmarksBackupDir = gProfD.clone();
  bookmarksBackupDir.append("bookmarkbackups");
  if (bookmarksBackupDir.exists()) {
    bookmarksBackupDir.remove(true);
    do_check_false(bookmarksBackupDir.exists());
  }
}


/**
 * Check a JSON backup file for today exists in the profile folder.
 *
 * @return nsIFile object for the file.
 */
function check_JSON_backup() {
  let profileBookmarksJSONFile = gProfD.clone();
  profileBookmarksJSONFile.append("bookmarkbackups");
  profileBookmarksJSONFile.append(FILENAME_BOOKMARKS_JSON);
  do_check_true(profileBookmarksJSONFile.exists());
  return profileBookmarksJSONFile;
}


/**
 * Waits for a frecency update then calls back.
 *
 * @param aURI
 *        URI or spec of the page we are waiting frecency for.
 * @param aValidator
 *        Validator function for the current frecency. If it returns true we
 *        have the expected frecency, otherwise we wait for next update.
 * @param aCallback
 *        function invoked when frecency update finishes.
 * @param aCbScope
 *        "this" scope for the callback
 * @param aCbArguments
 *        array of arguments to be passed to the callback
 *
 * @note since frecency is something that can be changed by a bunch of stuff
 *       like adding and removing visits, bookmarks we use a polling strategy.
 */
function waitForFrecency(aURI, aValidator, aCallback, aCbScope, aCbArguments) {
  Services.obs.addObserver(function (aSubject, aTopic, aData) {
    let frecency = frecencyForUrl(aURI);
    if (!aValidator(frecency)) {
      print("Has to wait for frecency...");
      return;
    }
    Services.obs.removeObserver(arguments.callee, aTopic);
    aCallback.apply(aCbScope, aCbArguments);
  }, "places-frecency-updated", false);
}

/**
 * Returns the frecency of a url.
 *
 * @param aURI
 *        The URI or spec to get frecency for.
 * @return the frecency value.
 */
function frecencyForUrl(aURI)
{
  let url = aURI instanceof Ci.nsIURI ? aURI.spec : aURI;
  let stmt = DBConn().createStatement(
    "SELECT frecency FROM moz_places WHERE url = ?1"
  );
  stmt.bindByIndex(0, url);
  if (!stmt.executeStep())
    throw new Error("No result for frecency.");
  let frecency = stmt.getInt32(0);
  stmt.finalize();

  return frecency;
}

/**
 * Returns the hidden status of a url.
 *
 * @param aURI
 *        The URI or spec to get hidden for.
 * @return @return true if the url is hidden, false otherwise.
 */
function isUrlHidden(aURI)
{
  let url = aURI instanceof Ci.nsIURI ? aURI.spec : aURI;
  let stmt = DBConn().createStatement(
    "SELECT hidden FROM moz_places WHERE url = ?1"
  );
  stmt.bindByIndex(0, url);
  if (!stmt.executeStep())
    throw new Error("No result for hidden.");
  let hidden = stmt.getInt32(0);
  stmt.finalize();

  return !!hidden;
}

/**
 * Compares two times in usecs, considering eventual platform timers skews.
 *
 * @param aTimeBefore
 *        The older time in usecs.
 * @param aTimeAfter
 *        The newer time in usecs.
 * @return true if times are ordered, false otherwise.
 */
function is_time_ordered(before, after) {
  // Windows has an estimated 16ms timers precision, since Date.now() and
  // PR_Now() use different code atm, the results can be unordered by this
  // amount of time.  See bug 558745 and bug 557406.
  let isWindows = ("@mozilla.org/windows-registry-key;1" in Cc);
  // Just to be safe we consider 20ms.
  let skew = isWindows ? 20000000 : 0;
  return after - before > -skew;
}

/**
 * Waits for all pending async statements on the default connection, before
 * proceeding with aCallback.
 *
 * @param aCallback
 *        Function to be called when done.
 * @param aScope
 *        Scope for the callback.
 * @param aArguments
 *        Arguments array for the callback.
 *
 * @note The result is achieved by asynchronously executing a query requiring
 *       a write lock.  Since all statements on the same connection are
 *       serialized, the end of this write operation means that all writes are
 *       complete.  Note that WAL makes so that writers don't block readers, but
 *       this is a problem only across different connections.
 */
function waitForAsyncUpdates(aCallback, aScope, aArguments)
{
  let scope = aScope || this;
  let args = aArguments || [];
  let db = DBConn();
  db.createAsyncStatement("BEGIN EXCLUSIVE").executeAsync();
  db.createAsyncStatement("COMMIT").executeAsync({
    handleResult: function() {},
    handleError: function() {},
    handleCompletion: function(aReason)
    {
      aCallback.apply(scope, args);
    }
  });
}

/**
 * Tests if a given guid is valid for use in Places or not.
 *
 * @param aGuid
 *        The guid to test.
 * @param [optional] aStack
 *        The stack frame used to report the error.
 */
function do_check_valid_places_guid(aGuid,
                                    aStack)
{
  if (!aStack) {
    aStack = Components.stack.caller;
  }
  do_check_true(/^[a-zA-Z0-9\-_]{12}$/.test(aGuid), aStack);
}

/**
 * Retrieves the guid for a given uri.
 *
 * @param aURI
 *        The uri to check.
 * @param [optional] aStack
 *        The stack frame used to report the error.
 * @return the associated the guid.
 */
function do_get_guid_for_uri(aURI,
                             aStack)
{
  if (!aStack) {
    aStack = Components.stack.caller;
  }
  let stmt = DBConn().createStatement(
    "SELECT guid "
  + "FROM moz_places "
  + "WHERE url = :url "
  );
  stmt.params.url = aURI.spec;
  do_check_true(stmt.executeStep(), aStack);
  let guid = stmt.row.guid;
  stmt.finalize();
  do_check_valid_places_guid(guid, aStack);
  return guid;
}

/**
 * Tests that a guid was set in moz_places for a given uri.
 *
 * @param aURI
 *        The uri to check.
 * @param [optional] aGUID
 *        The expected guid in the database.
 */
function do_check_guid_for_uri(aURI,
                               aGUID)
{
  let caller = Components.stack.caller;
  let guid = do_get_guid_for_uri(aURI, caller);
  if (aGUID) {
    do_check_valid_places_guid(aGUID, caller);
    do_check_eq(guid, aGUID, caller);
  }
}

/**
 * Logs info to the console in the standard way (includes the filename).
 *
 * @param aMessage
 *        The message to log to the console.
 */
function do_log_info(aMessage)
{
  print("TEST-INFO | " + _TEST_FILE + " | " + aMessage);
}

/**
 * Compares 2 arrays returning whether they contains the same elements.
 *
 * @param a1
 *        First array to compare.
 * @param a2
 *        Second array to compare.
 * @param [optional] sorted
 *        Whether the comparison should take in count position of the elements.
 * @return true if the arrays contain the same elements, false otherwise.
 */
function do_compare_arrays(a1, a2, sorted)
{
  if (a1.length != a2.length)
    return false;

  if (sorted) {
    return a1.every(function (e, i) e == a2[i]);
  }
  else {
    return a1.filter(function (e) a2.indexOf(e) == -1).length == 0 &&
           a2.filter(function (e) a1.indexOf(e) == -1).length == 0;
  }
}
