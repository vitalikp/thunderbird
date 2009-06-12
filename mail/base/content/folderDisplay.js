/* ***** BEGIN LICENSE BLOCK *****
 *   Version: MPL 1.1/GPL 2.0/LGPL 2.1
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
 * The Original Code is Thunderbird Mail Client.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Messaging, Inc.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *   David Bienvenu <bienvenu@nventure.com>
 *   Siddharth Agarwal <sid.bugzilla@gmail.com>
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

Components.utils.import("resource://app/modules/dbViewWrapper.js");

var gFolderDisplay = null;
var gMessageDisplay = null;

var nsMsgFolderFlags = Components.interfaces.nsMsgFolderFlags;

/**
 * Abstraction for a widget that (roughly speaking) displays the contents of
 *  folders.  The widget belongs to a tab and has a lifetime as long as the tab
 *  that contains it.  This class is strictly concerned with the UI aspects of
 *  this; the DBViewWrapper class handles the view details (and is exposed on
 *  the 'view' attribute.)
 *
 * The search window subclasses this into the SearchFolderDisplayWidget rather
 *  than us attempting to generalize everything excessively.  This is because
 *  we hate the search window and don't want to clutter up this code for it.
 * The standalone message display window also subclasses us; we do not hate it,
 *  but it's not invited to our birthday party either.
 * For reasons of simplicity and the original order of implementation, this
 *  class does alter its behavior slightly for the benefit of the standalone
 *  message window.  If no tab info is provided, we avoid touching tabmail
 *  (which is good, because it won't exist!)  And now we guard against treeBox
 *  manipulations...
 */
function FolderDisplayWidget(aTabInfo, aMessageDisplayWidget) {
  this._tabInfo = aTabInfo;

  /// If the folder does not get handled by the DBViewWrapper, stash it here.
  ///  ex: when isServer is true.
  this._nonViewFolder = null;

  this.view = new DBViewWrapper(this);
  this.messageDisplay = aMessageDisplayWidget;
  this.messageDisplay.folderDisplay = this;

  /**
   * The XUL tree node, as retrieved by getDocumentElementById.  The caller is
   *  responsible for setting this.
   */
  this.tree = null;
  /**
   * The nsITreeBoxObject on the XUL tree node, accessible from this.tree as
   *  this.tree.boxObject and QueryInterfaced as such.  The caller is
   *  responsible for setting this.
   */
  this.treeBox = null;

  /**
   * The nsIMsgWindow corresponding to the window that holds us.  There is only
   *  one of these per tab.  The caller is responsible for setting this.
   */
  this.msgWindow = null;
  /**
   * The nsIMessenger instance that corresponds to our tab/window.  We do not
   *  use this ourselves, but are responsible for using it to update the
   *  global |messenger| object so that our tab maintains its own undo and
   *  navigation history.  At some point we might touch it for those reasons.
   */
  this.messenger = null;
  this.threadPaneCommandUpdater = this;

  /**
   * Flag to expose whether all messages are loaded or not.  Set by
   *  onAllMessagesLoaded.
   */
  this._allMessagesLoaded = false;

  /**
   * Save the top row displayed when we go inactive, restore when we go active,
   *  nuke it when we destroy the view.
   */
  this._savedFirstVisibleRow = null;
  /** the next view index to select once the delete completes */
  this._nextViewIndexAfterDelete = null;
  /**
   * Track when a mass move is in effect (we get told by hintMassMoveStarting,
   *  and hintMassMoveCompleted) so that we can avoid deletion-triggered
   *  moving to _nextViewIndexAfterDelete until the mass move completes.
   */
  this._massMoveActive = false;

  /**
   * Used by pushNavigation to queue a navigation request for when we enter the
   *  next folder; onAllMessagesLoaded is the one that processes it.
   */
  this._pendingNavigation = null;

  this._active = false;
  /**
   * A list of methods to call on 'this' object when we are next made active.
   *  This list is populated by calls to |_notifyWhenActive| when we are
   *  not active at the moment.
   */
  this._notificationsPendingActivation = [];

  let dummyDOMNode = document.getElementById('mail-toolbox');
  /**
   * Create a fake tree box object for if/when this folder is in the background.
   * We need to give it a bogus DOM object to send events to, so we choose the
   *  mail-toolbox, who is hopefully unlikely to take offense.
   */
  this._fakeTreeBox = dummyDOMNode ?
                        new FakeTreeBoxObject(dummyDOMNode.boxObject) : null;

  this._mostRecentSelectionCounts = [];
  this._mostRecentCurrentIndices = [];
}
FolderDisplayWidget.prototype = {
  /**
   * @return the currently displayed folder.  This is just proxied from the
   *     view wrapper.
   */
  get displayedFolder() {
    return this._nonViewFolder || this.view.displayedFolder;
  },

  /**
   * @return the nsITreeSelection object for our tree view if there is one,
   *     null otherwise.
   */
  get treeSelection() {
    if (this.view.dbView)
      return this.view.dbView.selection;
    else
      return null;
  },

  /**
   * Number of headers to tell the message database to cache when we enter a
   *  folder.  This value is being propagated from legacy code which provided
   *  no explanation for its choice.
   *
   * We definitely want the header cache size to be larger than the number of
   *  rows that can be displayed on screen simultaneously.
   */
  PERF_HEADER_CACHE_SIZE: 100,

  /**
   * An optional list where each item is an object with the following
   *  attributes sufficient to re-establish the selected items even in the face
   *  of folder renaming.
   * - messageId: The value of the message's message-id header.
   *
   * That's right, we only save the message-id header value.  This is arguably
   *  overkill and ambiguous in the face of duplicate messages, but it's the
   *  most persistent/reliable thing we have without gloda.
   * Using the view index was ruled out because it is hardly stable.  Using the
   *  message key alone is insufficient for cross-folder searches.  Using a
   *  folder identifier and message key is insufficent for local folders in the
   *  face of compaction, let alone complexities where the folder name may
   *  change due to renaming/moving.  Which means we eventually need to fall
   *  back to message-id anyways.  Feel free to add in lots of complexity if
   *  you actually write unit tests for all the many possible cases.
   * Additional justification is that selection saving/restoration should not
   *  happen all that frequently.  A nice freebie is that message-id is
   *  definitely persistable.
   */
  _savedSelection: null,

  /**
   * Save the current view selection for when we the view is getting destroyed
   *  or otherwise re-ordered in such a way that the nsITreeSelection will lose
   *  track of things (because it just has a naive view-index 'view' of the
   *  world.)  We just save each message's message-id header.  This is overkill
   *  and ambiguous in the face of duplicate messages (and expensive to
   *  restore), but is also the most reliable option for this use case.
   */
  _saveSelection: function FolderDisplayWidget_saveSelection() {
    this._savedSelection = [{messageId: msgHdr.messageId} for each
                              ([, msgHdr] in Iterator(this.selectedMessages))];
  },

  /**
   * Clear the saved selection.
   */
  _clearSavedSelection: function FolderDisplayWidget_clearSavedSelection() {
    this._savedSelection = null;
  },

  /**
   * Restore the view selection if we have a saved selection.  We must be
   *  active!
   *
   * @return true if we were able to restore the selection and there was
   *     a selection, false if there was no selection (anymore).
   */
  _restoreSelection: function FolderDisplayWidget_restoreSelection() {
    if (!this._savedSelection || !this._active)
      return false;

    // translate message IDs back to messages.  this is O(s(m+n)) where:
    // - s is the number of messages saved in the selection
    // - m is the number of messages in the view (from findIndexOfMsgHdr)
    // - n is the number of messages in the underlying folders (from
    //   DBViewWrapper.getMsgHdrForMessageID).
    // which ends up being O(sn)
    var msgHdr;
    let messages =
      [msgHdr for each
        ([, savedInfo] in Iterator(this._savedSelection)) if
        ((msgHdr = this.view.getMsgHdrForMessageID(savedInfo.messageId)))];

    this.selectMessages(messages, true);
    this._savedSelection = null;

    return this.selectedCount != 0;
  },

  /**
   * Maps column ids to functions that test whether the column is legal for
   *  display for the folder.  Each function should expect a DBViewWrapper
   *  instance as its argument.  The intent is that the various helper
   *  properties like isMailFolder/isIncomingFolder/isOutgoingFolder allow the
   *  constraint to be expressed concisely.  If a helper does not exist, add
   *  one! (If doing so is out of reach, than access viewWrapper.displayedFolder
   *  to get at the nsIMsgFolder.)
   * If a column does not have a function, it is assumed to be legal for display
   *  in all cases.
   */
  COLUMN_LEGALITY_TESTERS: {
    // Only show 'Received' column for e-mails.  For newsgroup messages, the
    // 'Date' header is as reliable as an e-mail's 'Received' header, as it is
    // replaced with the news server's (more reliable) date.
    receivedCol: function (viewWrapper) {
      return viewWrapper.isMailFolder && !viewWrapper.isOutgoingFolder;
    },
    // senderCol = From.  You only care in incoming folders.
    senderCol: function (viewWrapper) {
      return viewWrapper.isIncomingFolder;
    },
    // recipient = To. You only care in outgoing folders.
    recipientCol: function (viewWrapper) {
      return viewWrapper.isOutgoingFolder;
    },
    // Only show the location column for non-single-folder results
    locationCol: function(viewWrapper) {
      return !viewWrapper.isSingleFolder;
    },
  },

  /**
   * If we determine that a column is illegal but was displayed, use this
   *  mapping to find suggested legal alternatives.  This basically exists
   *  just to flip-flop between senderCol and recipientCol.
   */
  COLUMN_LEGAL_ALTERNATIVES: {
    // swap between sender and recipient
    senderCol: ["recipientCol"],
    recipientCol: ["senderCol"],
    // if we nuke received, put back date...
    receivedCol: ["dateCol"],
  },

  /**
   * Columns to display whenever we can.  This is currently a bit of a hack to
   *  always show the location column when relevant.  Arguably, it would be
   *  better to use this as a default for a folder you've never been in and
   *  the rest of the time we restore the last column set for that folder from
   *  properties.
   */
  COLUMNS_DISPLAY_WHEN_POSSIBLE: ["locationCol"],

  /**
   * Update the displayed columns so that:
   * - Only legal columns (per COLUMN_LEGALITY_TESTERS) are displayed.
   * - Alternatives to now-illegal columns may be displayed.
   */
  updateColumns: function() {
    // Keep a list of columns we might want to make show up if they are not
    //  illegal.
    let legalize = this.COLUMNS_DISPLAY_WHEN_POSSIBLE.concat();

    // figure out who is illegal and make them go away
    for (let [colId, legalityFunc] in Iterator(this.COLUMN_LEGALITY_TESTERS)) {
      let column = document.getElementById(colId);
      // The search window does not have all the columns we know about, bail in
      //  such cases.
      if (!column)
        continue;
      let legal = legalityFunc(this.view);

      if (!legal) {
        let isHidden = column.getAttribute("hidden") == "true";
        // If it wasn't hidden, consider making its alternatives visible in the
        //  next pass.
        if (!isHidden && (colId in this.COLUMN_LEGAL_ALTERNATIVES))
          legalize = legalize.concat(this.COLUMN_LEGAL_ALTERNATIVES[colId]);
        // but definitely hide the heck out of it right now
        column.setAttribute("hidden", true);
        column.setAttribute("ignoreincolumnpicker", true);
      }
      else {
        column.removeAttribute("ignoreincolumnpicker");
      }
    }
    // If we have any columns we should consider making visible because they are
    //  alternatives to columns that became illegal, uh, do that.
    for each (let [, colId] in Iterator(legalize)) {
      let column = document.getElementById(colId);
      let isLegal = column.getAttribute("ignoreincolumnpicker") != "true";
      let isHidden = column.getAttribute("hidden") == "true";
      if (isLegal && isHidden)
        column.removeAttribute("hidden");
    }
  },

  /**
   * @param aColumnMap an object where the attribute names are column ids and
   *     the values are a boolean indicating whether the column should be
   *     visible or not.  If a column is not in the map, it is assumed that it
   *     should be hidden.
   */
  setVisibleColumns: function(aColumnMap) {
    let cols = document.getElementById("threadCols");
    let colChildren = cols.children;

    // because the splitter correspondence can be confusing and tricky, let's
    //  build a list of the nodes ordered by their ordinal
    let ordinalOrdered = [], iKid;
    for (iKid = 0; iKid < colChildren.length; iKid++)
      ordinalOrdered.push(null);

    for (iKid = 0; iKid < colChildren.length; iKid++) {
      let colChild = colChildren[iKid];
      let ordinal = colChild.getAttribute("ordinal") - 1;
      ordinalOrdered[ordinal] = colChild;
    }

    function twiddleAround(index, makeHidden) {
      if (index + 1 < ordinalOrdered.length) {
        let nexty = ordinalOrdered[index+1];
        if (nexty) {
          let isHidden = nexty.getAttribute("hidden") == "true";
          if (isHidden != makeHidden) {
            nexty.setAttribute("hidden", true);
            return;
          }
        }
      }
      if (index - 1 > 0) {
        let prevy = ordinalOrdered[index-1];
        if (prevy) {
          let isHidden = prevy.getAttribute("hidden") == "true";
          if (isHidden != makeHidden) {
            prevy.setAttribute("hidden", true);
            return;
          }
        }
      }
    }

    for (iKid = 0; iKid < ordinalOrdered.length; iKid++) {
      let colChild = ordinalOrdered[iKid];
      if (colChild == null)
        continue;

      if (colChild.tagName == "treecol") {
        if (colChild.id in aColumnMap) {
          // only need to do something if currently hidden
          if (colChild.getAttribute("hidden") == "true") {
            colChild.removeAttribute("hidden");
            twiddleAround(iKid, false);
          }
        }
        else {
          // only need to do something if currently visible
          if (colChild.getAttribute("hidden") != "true") {
            colChild.setAttribute("hidden", true);
            twiddleAround(iKid, true);
          }
        }
      }
    }
  },

  _savedColumnStates: null,

  /**
   * For now, just save the visible columns into a dictionary for use in a
   *  subsequent call to setVisibleColumns.  This does not do anything about
   *  re-arranging columns.
   */
  saveColumnStates: function() {
    // In the actual nsITreeColumn, the index property indicates the column
    //  number.  This column number is a 0-based index with no gaps; it only
    //  increments the number each time it sees a column.
    // However, this is subservient to the 'ordinal' property which
    //  defines the _apparent content sequence_ provided by GetNextSibling.
    //  The underlying content ordering is still the same, which is how
    //  restoreNaturalOrder can reset things to their XUL definition sequence.
    //  The 'ordinal' stuff works because nsBoxFrame::RelayoutChildAtOrdinal
    //  messes with the sibling relationship.
    // Ordinals are 1-based.  restoreNaturalOrder apparently is dumb and does
    //  not know this, although the ordering is relative so it doesn't actually
    //  matter.  The annoying splitters do have ordinals, and live between
    //  tree columns.  The splitters adjacent to a tree column do not need to
    //  have any 'ordinal' relationship, although it would appear user activity
    //  tends to move them around in a predictable fashion with oddness involved
    //  at the edges.
    // Changes to the ordinal attribute should take immediate effect in terms of
    //  sibling relationship, but will merely invalidate the columns rather than
    //  cause a re-computaiton of column relationships every time.
    // restoreNaturalOrder invalidates the tree when it is done re-ordering; I'm
    //  not sure that's entirely necessary...

    let visibleMap = {};

    let cols = document.getElementById("threadCols");
    let colChildren = cols.children;
    for (let iKid = 0; iKid < colChildren.length; iKid++) {
      let colChild = colChildren[iKid];
      if (colChild.getAttribute("hidden") != "true")
        visibleMap[colChild.id] = true;
    }

    this._savedColumnStates = visibleMap;
  },

  /**
   * Restores the visible columns saved by saveColumnStates.  Some day, in the
   *  future we might do something about positions and the like.  But we don't
   *  currently.
   */
  restoreColumnStates: function () {
    if (this._savedColumnStates) {
      this.setVisibleColumns(this._savedColumnStates);
      this._savedColumnStates = null;
    }
  },

  showFolderUri: function FolderDisplayWidget_showFolderUri(aFolderURI) {
    return this.show(GetMsgFolderFromUri(aFolderURI));
  },

  /**
   * Invoked by showFolder when it turns out the folder is in fact a server.
   */
  _showServer: function FolderDisplayWidget__showServer() {
    // currently nothing to do.  makeActive handles everything for us (because
    //  what is displayed needs to be re-asserted each time we are activated
    //  too.)
  },

  /**
   * Select a folder for display.
   *
   * @param aFolder The nsIMsgDBFolder to display.
   */
  show: function FolderDisplayWidget_show(aFolder) {
    if (aFolder == null) {
      this._nonViewFolder = null;
      this.view.close();
    }
    else if (aFolder instanceof Components.interfaces.nsIMsgFolder) {
      if (aFolder.isServer) {
        this._nonViewFolder = aFolder;
        this._showServer();
        this.view.close();
        // A server is fully loaded immediately, for now.  (When we have the
        //  account summary, we might want to change this to wait for the page
        //  load to complete.)
        this._allMessagesLoaded = true;
      }
      else {
        this._nonViewFolder = null;
        this.view.open(aFolder);
      }
    }
    // it must be a synthetic view
    else {
      this.view.openSynthetic(aFolder);
    }
    if (this._active)
      this.makeActive();

    if (this._tabInfo)
      document.getElementById('tabmail').setTabTitle(this._tabInfo);
  },

  /**
   * Clone an existing view wrapper as the basis for our display.
   */
  cloneView: function FolderDisplayWidget_cloneView(aViewWrapper) {
    this.view = aViewWrapper.clone(this);
    // generate a view created notification; this will cause us to do the right
    //  thing in terms of associating the view with the tree and such.
    this.onCreatedView();
    if (this._active)
      this.makeActive();
  },

  /**
   * Close resources associated with the currently displayed folder because you
   *  no longer care about this FolderDisplayWidget.
   */
  close: function FolderDisplayWidget_close() {
    // Mark ourselves as inactive without doing any of the hard work of becoming
    //  inactive.  This saves us from trying to update things as they go away.
    this._active = false;
    // Tell the message display to close itself too.  We do this before we do
    //  anything else because closing the view could theoretically propagate
    //  down to the message display and we don't want it doing anything it
    //  doesn't have to do.
    this.messageDisplay._close();

    this.view.close();
    this.messenger.setWindow(null, null);
    this.messenger = null;
    this._fakeTreeBox = null;
  },

  /*   ===============================   */
  /* ===== IDBViewWrapper Listener ===== */
  /*   ===============================   */

  /**
   * @return true if the mail view picker is visible.  This affects whether the
   *     DBViewWrapper will actually use the persisted mail view or not.
   */
  get shouldUseMailViews() {
    return ViewPickerBinding.isVisible;
  },

  /**
   * Let the viewWrapper know if we should defer message display because we
   *  want the user to connect to the server first so password authentication
   *  can occur.
   *
   * @return true if the folder should be shown immediately, false if we should
   *     wait for updateFolder to complete.
   */
  get shouldDeferMessageDisplayUntilAfterServerConnect() {
    let passwordPromptRequired = false;

    if (gPrefBranch.getBoolPref("mail.password_protect_local_cache"))
      passwordPromptRequired =
        this.view.displayedFolder.server.passwordPromptRequired;

    return passwordPromptRequired;
  },

  /**
   * Let the viewWrapper know if it should mark the messages read when leaving
   *  the provided folder.
   *
   * @return true if the preference is set for the folder's server type.
   */
  shouldMarkMessagesReadOnLeavingFolder:
    function FolderDisplayWidget_crazyMarkOnReadChecker (aMsgFolder) {
      return gPrefBranch.getBoolPref("mailnews.mark_message_read." +
                                     aMsgFolder.server.type);
  },

  /**
   * The view wrapper tells us when it starts loading a folder, and we set the
   *  cursor busy.  Setting the cursor busy on a per-tab basis is us being
   *  nice to the future. Loading a folder is a blocking operation that is going
   *  to make us unresponsive and accordingly make it very hard for the user to
   *  change tabs.
   */
  onFolderLoading: function(aFolderLoading) {
    if (this._tabInfo)
      document.getElementById("tabmail").setTabBusy(this._tabInfo,
                                                    aFolderLoading);
  },

  /**
   * The view wrapper tells us when a search is active, and we mark the tab as
   *  thinking so the user knows something is happening.  'Searching' in this
   *  case is more than just a user-initiated search.  Virtual folders / saved
   *  searches, mail views, plus the more obvious quick search are all based off
   *  of searches and we will receive a notification for them.
   */
  onSearching: function(aIsSearching) {
    // getDocumentElements() sets gSearchBundle
    getDocumentElements();
    if (this._tabInfo)
      document.getElementById("tabmail").setTabThinking(
        this._tabInfo,
        aIsSearching && gSearchBundle.getString("searchingMessage"));
  },

  /**
   * Things we do on creating a view:
   * - notify the observer service so that custom column handler providers can
   *   add their custom columns to our view.
   */
  onCreatedView: function FolderDisplayWidget_onCreatedView() {
    // All of our messages are not displayed if the view was just created.  We
    //  will get an onAllMessagesLoaded nearly immediately if this is a local
    //  folder where view creation is synonymous with having all messages.
    this._allMessagesLoaded = false;
    this.messageDisplay.onCreatedView();
    this._notifyWhenActive(this._activeCreatedView);
  },
  _activeCreatedView: function() {
    gDBView = this.view.dbView;

    // A change in view may result in changes to sorts, the view menu, etc.
    // Do this before we 'reroot' the dbview.
    this._updateThreadDisplay();

    // this creates a new selection object for the view.
    if (this.treeBox)
      this.treeBox.view = this.view.dbView;

    let ObserverService =
      Components.classes["@mozilla.org/observer-service;1"]
                .getService(Components.interfaces.nsIObserverService);
    // The data payload used to be viewType + ":" + viewFlags.  We no longer
    //  do this because we already have the implied contract that gDBView is
    //  valid at the time we generate the notification.  In such a case, you
    //  can easily get that information from the gDBView.  (The documentation
    //  on creating a custom column assumes gDBView.)
    ObserverService.notifyObservers(this.displayedFolder,
                                    "MsgCreateDBView", "");
  },

  /**
   * If our view is being destroyed and it is coming back, we want to save the
   *  current selection so we can restore it when the view comes back.
   */
  onDestroyingView: function FolderDisplayWidget_onDestroyingView(
      aFolderIsComingBack) {
    // try and persist the selection's content if we can
    if (this._active) {
      if (aFolderIsComingBack)
        this._saveSelection();
      else
        this._clearSavedSelection();
      gDBView = null;
    }

    // if we have no view, no messages could be loaded.
    this._allMessagesLoaded = false;

    // but the actual tree view selection (based on view indicies) is a goner no
    //  matter what, make everyone forget.
    this.view.dbView.selection = null;
    this._savedFirstVisibleRow = null;
    this._nextViewIndexAfterDelete = null;
    // although the move may still be active, its relation to the view is moot.
    this._massMoveActive = false;

    // Anything pending needs to get cleared out; the new view and its related
    //  events will re-schedule anything required or simply run it when it
    //  has its initial call to makeActive compelled.
    this._notificationsPendingActivation = [];

    // and the message display needs to forget
    this.messageDisplay.onDestroyingView(aFolderIsComingBack);
  },
  /**
   * We are entering the folder for display, set the header cache size.
   */
  onDisplayingFolder: function FolderDisplayWidget_onDisplayingFolder() {
    let msgDatabase = this.view.displayedFolder.msgDatabase;
    if (msgDatabase) {
      msgDatabase.resetHdrCacheSize(this.PERF_HEADER_CACHE_SIZE);
    }

    // the quick-search gets nuked when we show a new folder
    ClearQSIfNecessary();
    // update the quick-search relative to whether it's incoming/outgoing
    onSearchFolderTypeChanged(this.view.isOutgoingFolder);

    if (this.active)
      this.makeActive();
  },

  /**
   * Notification from DBViewWrapper that it is closing the folder.  This can
   *  happen for reasons other than our own 'close' method closing the view.
   *  For example, user deletion of the folder or underlying folder closes it.
   */
  onLeavingFolder: function FolderDisplayWidget_onLeavingFolder() {
    // Keep the msgWindow's openFolder up-to-date; it powers nsMessenger's
    //  concept of history so that it can bring you back to the actual folder
    //  you were looking at, rather than just the underlying folder.
    if (this._active)
      msgWindow.openFolder = null;
  },

  /**
   * Indictes whether we are done loading the messages that should be in this
   *  folder.  This is being surfaced for testing purposes, but could be useful
   *  to other code as well.  But don't poll this property; ask for an event
   *  that you can hook.
   */
  get allMessagesLoaded FolderDisplayWidget_get_allMessagesLoaded() {
    return this._allMessagesLoaded;
  },

  /**
   * Things to do once all the messages that should show up in a folder have
   *  shown up.  For a real folder, this happens when the folder is entered.
   *  For a virtual folder, this happens when the search completes.
   *
   * What we do:
   * - Any scrolling required!
   */
  onAllMessagesLoaded: function() {
    this._allMessagesLoaded = true;
    this._notifyWhenActive(this._activeAllMessagesLoaded);
  },
  _activeAllMessagesLoaded: function() {
    // - restore selection
    // Attempt to restore the selection (if we saved it because the view was
    //  being destroyed or otherwise manipulated in a fashion that the normal
    //  nsTreeSelection would be unable to handle.)
    if (this._restoreSelection()) {
      this.ensureRowIsVisible(this.view.dbView.viewIndexForFirstSelectedMsg);
      return;
    }

    // - pending navigation from pushNavigation (probably spacebar triggered)
    if (this._pendingNavigation) {
      // Move it to a local and clear the state in case something bad happens.
      //  (We don't want to swallow the exception.)
      let pendingNavigation = this._pendingNavigation;
      this._pendingNavigation = null;
      this.navigate.apply(this, pendingNavigation);
      return;
    }

    // - new messages
    // if configured to scroll to new messages, try that
    if (gPrefBranch.getBoolPref("mailnews.scroll_to_new_message") &&
        this.navigate(nsMsgNavigationType.firstNew, /* select */ false))
      return;

    // - last selected message
    // if configured to load the last selected message (this is currently more
    //  persistent than our saveSelection/restoreSelection stuff), and the view
    //  is backed by a single underlying folder (the only way having just a
    //  message key works out), try that
    if (gPrefBranch.getBoolPref("mailnews.remember_selected_message") &&
        this.view.isSingleFolder) {
      // use the displayed folder; nsMsgDBView goes to the effort to save the
      //  state to the viewFolder, so this is the correct course of action.
      let lastLoadedMessageKey = this.view.displayedFolder.lastMessageLoaded;
      if (lastLoadedMessageKey != nsMsgKey_None) {
        this.view.dbView.selectMsgByKey(lastLoadedMessageKey);
        // The message key may not be present in the view for a variety of
        //  reasons.  Beyond message deletion, it simply may not match the
        //  active mail view or quick search, for example.
        if (this.view.dbView.numSelected) {
          this.ensureRowIsVisible(
            this.view.dbView.viewIndexForFirstSelectedMsg);
          return;
        }
      }
    }

    // - towards the newest messages, but don't select
    if (this.view.isSortedAscending && this.view.sortImpliesTemporalOrdering &&
      this.navigate(nsMsgNavigationType.lastMessage, /* select */ false))
      return;

    // - to the top, the coliseum
    this.ensureRowIsVisible(0);
  },

  /**
   * The DBViewWrapper tells us when someone (possibly the wrapper itself)
   *  changes the active mail view so that we can kick the UI to update.
   */
  onMailViewChanged: function FolderDisplayWidget_onMailViewChanged() {
    // only do this if we're currently active.  no need to queue it because we
    //  always update the mail view whenever we are made active.
    if (this.active) {
      let event = document.createEvent("datacontainerevents");
      // you cannot cancel a view change!
      event.initEvent("MailViewChanged", false, false);
      //event.setData("folderDisplay", this);
      window.dispatchEvent(event);
    }
  },

  /**
   * Just the sort or threading was changed, without changing other things.  We
   *  will not get this notification if the view was re-created, for example.
   */
  onSortChanged: function FolderDisplayWidget_onSortChanged() {
    if (this.active)
      UpdateSortIndicators(this.view.primarySortType,
                           this.view.primarySortOrder);
  },

  /**
   * Messages (that may have been displayed) have been removed; this may impact
   *  our message selection.  If we saw this coming, then
   *  this._nextViewIndexAfterDelete should know what view index we should
   *  select next.  If we didn't see this coming, the cause is likely an
   *  explicit deletion in another tab/window.
   * Because the nsMsgDBView is on top of things, it will already have called
   *  summarizeSelection as a result of the changes to the message display.
   *  So our job here is really just to try and potentially improve on the
   *  default selection logic.
   */
  onMessagesRemoved: function FolderDisplayWidget_onMessagesRemoved() {
    // - we saw this coming
    let rowCount = this.view.dbView.rowCount;
    if (!this._massMoveActive && (this._nextViewIndexAfterDelete != null)) {
      // adjust the index if it is after the last row...
      // (this can happen if the "mail.delete_matches_sort_order" pref is not
      //  set and the message is the last message in the view.)
      if (this._nextViewIndexAfterDelete >= rowCount)
        this._nextViewIndexAfterDelete = rowCount - 1;
      // just select the index and get on with our lives
      this.selectViewIndex(this._nextViewIndexAfterDelete);
      this._nextViewIndexAfterDelete = null;
      return;
    }

    // - surprise!
    // A deletion happened to our folder.
    let treeSelection = this.treeSelection;
    // we can't fix the selection if we have no selection
    if (!treeSelection)
      return;

    // For reasons unknown (but theoretically knowable), sometimes the selection
    //  object will be invalid.  At least, I've reliably seen a selection of
    //  [0, 0] with 0 rows.  If that happens, we need to fix up the selection
    //  here.
    if (rowCount == 0 && treeSelection.count)
      // nsTreeSelection does't generate an event if we use clearRange, so use
      //  that to avoid spurious events, given that we are going to definitely
      //  trigger a change notification below.
      treeSelection.clearRange(0, 0);

    // Check if we now no longer have a selection, but we had exactly one
    //  message selected previously.  If we did, then try and do some
    //  'persistence of having a thing selected'.
    if (treeSelection.count == 0 &&
        this._mostRecentSelectionCounts.length > 1 &&
        this._mostRecentSelectionCounts[1] == 1 &&
        this._mostRecentCurrentIndices[1] != -1) {
      let targetIndex = this._mostRecentCurrentIndices[1];
      if (targetIndex >= rowCount)
        targetIndex = rowCount - 1;
      this.selectViewIndex(targetIndex);
      return;
    }

    // Otherwise, just tell the view that things have changed so it can update
    //  itself to the new state of things.
    // tell the view that things have changed so it can update itself suitably.
    if (this.view.dbView)
      this.view.dbView.selectionChanged();
  },

  /**
   * Messages were not actually removed, but we were expecting that they would
   *  be.  Clean-up what onMessagesRemoved would have cleaned up, namely the
   *  next view index to select.
   */
  onMessageRemovalFailed:
      function FolderDisplayWidget_onMessageRemovalFailed() {
    this._nextViewIndexAfterDelete = null;
  },

  /**
   * Update the status bar to reflect our exciting message counts.
   */
  onMessageCountsChanged: function FolderDisplayWidget_onMessageCountsChaned() {
    if (this.active)
      UpdateStatusMessageCounts(this.displayedFolder);
  },

  /* ===== End IDBViewWrapperListener ===== */

  /*   ==================================   */
  /* ===== nsIMsgDBViewCommandUpdater ===== */
  /*   ==================================   */

  /**
   * This gets called when the selection changes AND !suppressCommandUpdating
   *  AND (we're not removing a row OR we are now out of rows).
   * In response, we update the toolbar.
   */
  updateCommandStatus: function FolderDisplayWidget_updateCommandStatus() {
    UpdateMailToolbar("FolderDisplayWidget command updater notification");
  },

  /**
   * This gets called by nsMsgDBView::UpdateDisplayMessage following a call
   *  to nsIMessenger.OpenURL to kick off message display OR (UDM gets called)
   *  by nsMsgDBView::SelectionChanged in lieu of loading the message because
   *  mSupressMsgDisplay.
   * In other words, we get notified immediately after the process of displaying
   *  a message triggered by the nsMsgDBView happens.  We get some arguments
   *  that are display optimizations for historical reasons (as usual).
   *
   * Things this makes us want to do:
   * - Set the tab title, perhaps.  (If we are a message display.)
   * - Update message counts, because things might have changed, why not.
   * - Update some toolbar buttons, why not.
   *
   * @param aFolder The display/view folder, as opposed to the backing folder.
   * @param aSubject The subject with "Re: " if it's got one, which makes it
   *     notably different from just directly accessing the message header's
   *     subject.
   * @param aKeywords The keywords, which roughly translates to message tags.
   */
  displayMessageChanged: function FolderDisplayWidget_displayMessageChanged(
      aFolder, aSubject, aKeywords) {
    UpdateMailToolbar("FolderDisplayWidget displayed message changed");
    let viewIndex = this.view.dbView.currentlyDisplayedMessage;
    let msgHdr = (viewIndex != nsMsgViewIndex_None) ?
                   this.view.dbView.getMsgHdrAt(viewIndex) : null;
    this.messageDisplay.onDisplayingMessage(msgHdr);

    // Although deletes should now be so fast that the user has no time to do
    //  anything, treat the user explicitly choosing to display a different
    //  message as invalidating the choice we automatically made for them when
    //  they initiated the message delete / move. (bug 243532)
    // Note: legacy code used to check whether the message being displayed was
    //  the one being deleted, so it didn't erroneously clear the next message
    //  to display (bug 183394).  This is not a problem for us because we hook
    //  our notification when the message load is initiated, rather than when
    //  the message completes loading.
    this._nextViewIndexAfterDelete = null;
  },

  /**
   * This gets called as a hint that the currently selected message is junk and
   *  said junked message is going to be moved out of the current folder.  The
   *  legacy behaviour is to retrieve the msgToSelectAfterDelete attribute off
   *  the db view, stashing it for benefit of the code that gets called when a
   *  message move/deletion is completed so that we can trigger its display.
   */
  updateNextMessageAfterDelete:
      function FolderDisplayWidget_updateNextMessageAfterDelete() {
    this.hintAboutToDeleteMessages();
  },

  /**
   * The most recent currentIndexes on the selection (from the last time
   *  summarizeSelection got called).  We use this in onMessagesRemoved if
   *  we get an unexpected notification.
   * We keep a maximum of 2 entries in this list.
   */
  _mostRecentCurrentIndices: undefined, // initialized in constructor
  /**
   * The most recent counts on the selection (from the last time
   *  summarizeSelection got called).  We use this in onMessagesRemoved if
   *  we get an unexpected notification.
   * We keep a maximum of 2 entries in this list.
   */
  _mostRecentSelectionCounts: undefined, // initialized in constructor

  /**
   * Always called by the db view when the selection changes in
   *  SelectionChanged.  This event will come after the notification to
   *  displayMessageChanged (if one happens), and before the notification to
   *  updateCommandStatus (if one happens).
   */
  summarizeSelection: function FolderDisplayWidget_summarizeSelection() {
    // save the current index off in case the selection gets deleted out from
    //  under us and we want to have persistence of actually-having-something
    //  selected.
    let treeSelection = this.treeSelection;
    if (treeSelection) {
      this._mostRecentCurrentIndices.unshift(treeSelection.currentIndex);
      this._mostRecentCurrentIndices.splice(2);
      this._mostRecentSelectionCounts.unshift(treeSelection.count);
      this._mostRecentSelectionCounts.splice(2);
    }
    return this.messageDisplay.onSelectedMessagesChanged();
  },

  /* ===== End nsIMsgDBViewCommandUpdater ===== */

  /* ===== Hints from the command infrastructure ===== */

  /**
   * doCommand helps us out by telling us when it is telling the view to delete
   *  some messages.  Ideally it should go through us / the DB View Wrapper to
   *  kick off the delete in the first place, but that's a thread I don't want
   *  to pull on right now.
   * We use this hint to figure out the next message to display once the
   *  deletion completes.  We do this before the deletion happens because the
   *  selection is probably going away (except in the IMAP delete model), and it
   *  might be too late to figure this out after the deletion happens.
   * Our automated complement (that calls us) is updateNextMessageAfterDelete.
   */
  hintAboutToDeleteMessages:
      function FolderDisplayWidget_hintAboutToDeleteMessages() {
    // If there is a right click going on, then the possibilities are:
    // 1) The user right-clicked in the selection.  In this case, the selection
    //    is maintained.  This holds true for one or multiple messages.
    // 2) The user right-clicked outside the selection.  In this case, the
    //    selection, but not the current index, reflects the single message
    //    the user right-clicked on.
    // We want to treat case #1 as if a right-click was not involved and we
    //  want to ignore case #2 by bailing because our existing selection (or
    //  lack thereof) we want maintained.
//    if (gRightMouseButtonDown && gRightMouseButtonChangedSelection)
//      return;

    // save the value, even if it is nsMsgViewIndex_None.
    this._nextViewIndexAfterDelete = this.view.dbView.msgToSelectAfterDelete;
  },

  /**
   * The archive code tells us when it is starting to archive messages.  This
   *  is different from hinting about deletion because it will also tell us
   *  when it has completed its mass move.
   * The UI goal is that we do not immediately jump beyond the selected messages
   *  to the next message until all of the selected messages have been
   *  processed (moved).  Ideally we would also do this when deleting messages
   *  from a multiple-folder backed message view, but we don't know when the
   *  last job completes in that case (whereas in this case we do because of the
   *  call to hintMassMoveCompleted.)
   */
  hintMassMoveStarting:
      function FolderDisplayWidget_hintMassMoveStarting() {
    this.hintAboutToDeleteMessages();
    this._massMoveActive = true;
  },

  /**
   * The archival has completed, we can finally let onMessagseRemoved run to
   *  completion.
   */
  hintMassMoveCompleted:
      function FolderDisplayWidget_hintMassMoveCompleted() {
    this._massMoveActive = false;
    this.onMessagesRemoved();
  },

  /**
   * When a right-click on the thread pane is going to alter our selection, we
   *  get this notification (currently from |ChangeSelectionWithoutContentLoad|
   *  in msgMail3PaneWindow.js), which lets us save our state.
   * This ends one of two ways: we get made inactive because a new tab popped up
   *  or we get a call to |hintRightClickSelectionPerturbationDone|.
   *
   * Ideally, we could just save off our current nsITreeSelection and restore it
   *  when this is all over.  This assumption would rely on the underlying view
   *  not having any changes to its rows before we restore the selection.  I am
   *  not confident we can rule out background processes making changes, plus
   *  the right-click itself may mutate the view (although we could try and get
   *  it to restore the selection before it gets to the mutation part).  Our
   *  only way to resolve this would be to create a 'tee' like fake selection
   *  that would proxy view change notifications to both sets of selections.
   *  That is hard.
   * So we just use the existing _saveSelection/_restoreSelection mechanism
   *  which is potentially very costly.
   */
  hintRightClickPerturbingSelection:
      function FolderDisplayWidget_hintRightClickPerturbingSelect() {
    this._saveSelection();
  },

  /**
   * When a right-click on the thread pane altered our selection (which we
   *  should have received a call to |hintRightClickPerturbingSelection| for),
   *  we should receive this notification from
   *  |RestoreSelectionWithoutContentLoad| when it wants to put things back.
   */
  hintRightClickSelectionPerturbationDone:
      function FolderDisplayWidget_hintRightClickSelectionPerturbationDone() {
    this._restoreSelection();
  },

  /* ===== End hints from the command infrastructure ==== */

  _updateThreadDisplay: function FolderDisplayWidget__updateThreadDisplay() {
    if (this.active) {
      if (this.view.dbView) {
        this.updateColumns();
        UpdateSortIndicators(this.view.dbView.sortType,
                             this.view.dbView.sortOrder);
        SetNewsFolderColumns();
      }
    }
  },

  /**
   * Update the UI display apart from the thread tree because the folder being
   *  displayed has changed.  This can be the result of changing the folder in
   *  this FolderDisplayWidget, or because this FolderDisplayWidget is being
   *  made active.  _updateThreadDisplay handles the parts of the thread tree
   *  that need updating.
   */
  _updateContextDisplay: function FolderDisplayWidget__updateContextDisplay() {
    if (this.active) {
      UpdateMailToolbar("FolderDisplayWidget updating context");
      UpdateStatusQuota(this.displayedFolder);
      UpdateStatusMessageCounts(this.displayedFolder);

      // - mail view combo-box.
      this.onMailViewChanged();
    }
  },

  /**
   * Run the provided notification function right now if we are 'active' (the
   *  currently displayed tab), otherwise queue it to be run when we become
   *  active.  We do this because our tabbing model uses multiplexed (reused)
   *  widgets, and extensions likewise depend on these global/singleton things.
   * If the requested notification function is already queued, it will not be
   *  added a second time, and the original call ordering will be maintained.
   *  If a new call ordering is required, the list of notifications should
   *  probably be reset by the 'big bang' event (new view creation?).
   */
  _notifyWhenActive: function (aNotificationFunc) {
    if (this._active) {
      aNotificationFunc.call(this);
    }
    else {
      if (this._notificationsPendingActivation.indexOf(aNotificationFunc) == -1)
        this._notificationsPendingActivation.push(aNotificationFunc);
    }
  },

  /**
   * Some notifications cannot run while the FolderDisplayWidget is inactive
   *  (presumbly because it is in a background tab).  We accumulate those in
   *  _notificationsPendingActivation and then this method runs them when we
   *  become active again.
   */
  _runNotificationsPendingActivation:
      function FolderDisplayWidget__runNotificationsPendingActivation() {
    if (!this._notificationsPendingActivation.length)
      return;

    let pendingNotifications = this._notificationsPendingActivation;
    this._notificationsPendingActivation = [];
    for each (let [, notif] in Iterator(pendingNotifications)) {
      notif.call(this);
    }
  },

  get active() {
    return this._active;
  },

  /**
   * Make this FolderDisplayWidget the 'active' widget by updating globals and
   *  linking us up to the UI widgets.  This is intended for use by the tabbing
   *  logic.
   */
  makeActive: function FolderDisplayWidget_makeActive(aWasInactive) {
    let wasInactive = !this._active;

    // -- globals
    // update per-tab globals that we own
    gFolderDisplay = this;
    gMessageDisplay = this.messageDisplay;
    gDBView = this.view.dbView;
    messenger = this.messenger;

    // update singleton globals' state
    msgWindow.openFolder = this.view.displayedFolder;

    this._active = true;
    this._runNotificationsPendingActivation();

    // -- UI

    // thread pane if we have a db view
    if (this.view.dbView) {
      // Make sure said thread pane is visible.  If we do this after we re-root
      //  the tree, the thread pane may not actually replace the account central
      //  pane.  Concerning...
      this._showThreadPane();

      // some things only need to happen if we are transitioning from inactive
      //  to active
      if (wasInactive) {
        // Setting the 'view' attribute on treeBox results in the following
        //  effective calls, noting that in makeInactive we made sure to null
        //  out its view so that it won't try and clean up any views or their
        //  selections.  (The actual actions happen in nsTreeBodyFrame::SetView)
        // - this.view.dbView.selection.tree = this.treeBox
        // - this.view.dbView.setTree(this.treeBox)
        // - this.treeBox.view = this.view.dbView (in nsTreeBodyObject::SetView)
        if (this.treeBox) {
          this.treeBox.view = this.view.dbView;
          if (this._savedFirstVisibleRow != null)
            this.treeBox.scrollToRow(this._savedFirstVisibleRow);

          this.restoreColumnStates();
        }

        // restore the quick search widget
        let searchInput = document.getElementById("searchInput");
        if (searchInput && this._savedQuickSearch) {
          searchInput.searchMode = this._savedQuickSearch.searchMode;
          if (this._savedQuickSearch.text) {
            searchInput.value = this._savedQuickSearch.text;
            searchInput.showingSearchCriteria = false;
            searchInput.clearButtonHidden = false;
          }
          else {
            searchInput.setSearchCriteriaText();
          }
        }
      }

      // the tab mode knows whether we are folder or message display, which
      //  impacts the legal modes
      if (this._tabInfo)
        mailTabType._setPaneStates(this._tabInfo.mode.legalPanes,
          {folder: !this._tabInfo.folderPaneCollapsed,
           message: !this._tabInfo.messagePaneCollapsed});

      // update the columns and such that live inside the thread pane
      this._updateThreadDisplay();

      this.messageDisplay.makeActive();
    }
    // account central stuff when we don't have a dbview
    else {
      this._showAccountCentral();
      if (this._tabInfo)
        mailTabType._setPaneStates(this._tabInfo.mode.legalPanes,
                                   {folder: !this._tabInfo.folderPaneCollapsed,
                                    message: false});
    }

    this._updateContextDisplay();
  },

  /**
   * Cause the displayDeck to display the thread pane.
   */
  _showThreadPane: function FolderDisplayWidget__showThreadPane() {
    document.getElementById("displayDeck").selectedPanel =
      document.getElementById("threadPaneBox");
  },

  /**
   * Cause the displayDeck to display the (preference configurable) account
   *  central page.
   */
  _showAccountCentral: function FolderDisplayWidget__showAccountCentral() {
    var accountBox = document.getElementById("accountCentralBox");
    document.getElementById("displayDeck").selectedPanel = accountBox;
    var prefName = "mailnews.account_central_page.url";
    // oh yeah, 'pref' is a global all right.
    var acctCentralPage =
      pref.getComplexValue(prefName,
                           Components.interfaces.nsIPrefLocalizedString).data;
    window.frames["accountCentralPane"].location.href = acctCentralPage;
  },

  /**
   * Call this when the tab using us is being hidden.
   */
  makeInactive: function FolderDisplayWidget_makeInactive() {
    this._active = false;
    // save the folder pane's state always
    this.folderPaneCollapsed =
      document.getElementById("folderPaneBox").collapsed;

    if (this.view.dbView) {
      if (this.treeBox)
        this._savedFirstVisibleRow = this.treeBox.getFirstVisibleRow();

      // save column states
      this.saveColumnStates();

      // save the message pane's state only when it is potentially visible
      this.messagePaneCollapsed =
        document.getElementById("messagepanebox").collapsed;

      // save the actual quick-search query text
      let searchInput = document.getElementById("searchInput");
      if (searchInput) {
        this._savedQuickSearch = {
          text: searchInput.showingSearchCriteria ? null : searchInput.value,
          searchMode: searchInput.searchMode
        };
      }

      // save off the tree selection object.  the nsTreeBodyFrame will make the
      //  view forget about it when our view is removed, so it's up to us to
      //  save it.
      let treeViewSelection = this.view.dbView.selection;
      // make the tree forget about the view right now so we can tell the db
      //  view about its selection object so it can try and keep it up-to-date
      //  even while hidden in the background
      if (this.treeBox)
        this.treeBox.view = null;
      // (and tell the db view about its selection again...)
      this.view.dbView.selection = treeViewSelection;

      // hook the dbview up to the fake tree box
      this._fakeTreeBox.view = this.view.dbView;
      this.view.dbView.setTree(this._fakeTreeBox);
      treeViewSelection.tree = this._fakeTreeBox;
    }

    this.messageDisplay.makeInactive();
  },

  /**
   * @return true if there is a db view and the command is enabled on the view.
   *  This function hides some of the XPCOM-odditities of the getCommandStatus
   *  call.
   */
  getCommandStatus: function FolderDisplayWidget_getCommandStatus(
      aCommandType, aEnabledObj, aCheckStatusObj) {
    // no view means not enabled
    if (!this.view.dbView)
      return false;
    let enabledObj = {}, checkStatusObj = {};
    this.view.dbView.getCommandStatus(aCommandType, enabledObj, checkStatusObj);
    return enabledObj.value;
  },

  /**
   * Make code cleaner by allowing peoples to call doCommand on us rather than
   *  having to do folderDisplayWidget.view.dbView.doCommand.
   *
   * @param aCommandName The command name to invoke.
   */
  doCommand: function FolderDisplayWidget_doCommand(aCommandName) {
    return this.view.dbView && this.view.dbView.doCommand(aCommandName);
  },

  /**
   * Make code cleaner by allowing peoples to call doCommandWithFolder on us
   *  rather than having to do:
   *  folderDisplayWidget.view.dbView.doCommandWithFolder.
   *
   * @param aCommandName The command name to invoke.
   * @param aFolder The folder context for the command.
   */
  doCommandWithFolder: function FolderDisplayWidget_doCommandWithFolder(
      aCommandName, aFolder) {
    return this.view.dbView &&
           this.view.dbView.doCommandWithFolder(aCommandName, aFolder);
  },



  /**
   * Navigate using nsMsgNavigationType rules and ensuring the resulting row is
   *  visible.  This is trickier than it used to be because we now support
   *  treating collapsed threads as the set of all the messages in the collapsed
   *  thread rather than just the root message in that thread.
   *
   * @param aNavType {nsMsgNavigationType} navigation command.
   * @param aSelect {Boolean} should we select the message if we find one?
   *     Defaults to true if omitted.
   *
   * @return true if the navigation constraint matched anything, false if not.
   *     We will have navigated if true, we will have done nothing if false.
   */
  navigate: function FolderDisplayWidget_navigate(aNavType, aSelect) {
    if (aSelect === undefined)
      aSelect = true;
    let resultKeyObj = {}, resultIndexObj = {}, threadIndexObj = {};

    let summarizeSelection =
      gPrefBranch.getBoolPref("mail.operate_on_msgs_in_collapsed_threads");

    let treeSelection = this.treeSelection; // potentially magic getter
    let currentIndex = treeSelection ? treeSelection.currentIndex : 0;

    let viewIndex;
    // if we're doing next unread, and a collapsed thread is selected, and
    // the top level message is unread, just set the result manually to
    // the top level message, without using viewNavigate.
    if (summarizeSelection &&
        aNavType == nsMsgNavigationType.nextUnreadMessage &&
        currentIndex != -1 &&
        this.view.isCollapsedThreadAtIndex(currentIndex) &&
        !(this.view.dbView.getFlagsAt(currentIndex) &
          nsMsgMessageFlags.Read)) {
      viewIndex = currentIndex;
    }
    else {
      // always 'wrap' because the start index is relative to the selection.
      // (keep in mind that many forms of navigation do not care about the
      //  starting position or 'wrap' at all; for example, firstNew just finds
      //  the first new message.)
      // allegedly this does tree-expansion for us.
      this.view.dbView.viewNavigate(aNavType, resultKeyObj, resultIndexObj,
                                    threadIndexObj, true);
      viewIndex = resultIndexObj.value;
    }

    if (viewIndex == nsMsgViewIndex_None)
      return false;

    // - Expand if required.
    // (The nsMsgDBView isn't really aware of the varying semantics of
    //  collapsed threads, so viewNavigate might tell us about the root message
    //  and leave it collapsed, not realizing that it needs to be expanded.)
    if (summarizeSelection &&
        this.view.isCollapsedThreadAtIndex(viewIndex))
      this.view.dbView.toggleOpenState(viewIndex);

    if (aSelect)
      this.selectViewIndex(viewIndex);
    else
      this.ensureRowIsVisible(viewIndex);
    return true;
  },

  /**
   * Push a call to |navigate| to be what we do once we successfully open the
   *  next folder.  This is intended to be used by cross-folder navigation
   *  code.  It should call this method before triggering the folder change.
   */
  pushNavigation: function FolderDisplayWidget_navigate(aNavType, aSelect) {
    this._pendingNavigation = [aNavType, aSelect];
  },

  /**
   * @return true if we are able to navigate using the given navigation type at
   *  this time.
   */
  navigateStatus: function FolderDisplayWidget_navigateStatus(aNavType) {
    if (!this.view.dbView)
      return false;
    return this.view.dbView.navigateStatus(aNavType);
  },

  /**
   * @returns the message header for the first selected message, or null if
   *  there is no selected message.
   *
   * If the user has right-clicked on a message, this method will return that
   *  message and not the 'current index' (the dude with the dotted selection
   *  rectangle around him.)  If you instead always want the currently
   *  displayed message (which is not impacted by right-clicking), then you
   *  would want to access the displayedMessage property on the
   *  MessageDisplayWidget.  You can get to that via the messageDisplay
   *  attribute on this object or (potentially) via the gMessageDisplay object.
   */
  get selectedMessage FolderDisplayWidget_get_selectedMessage() {
    // there are inconsistencies in hdrForFirstSelectedMessage between
    //  nsMsgDBView and nsMsgSearchDBView in whether they use currentIndex,
    //  do it ourselves.  (nsMsgDBView does not use currentIndex, search does.)
    let treeSelection = this.treeSelection;
    if (!treeSelection || !treeSelection.count)
      return null;
    let minObj = {}, maxObj = {};
    treeSelection.getRangeAt(0, minObj, maxObj);
    return this.view.dbView.getMsgHdrAt(minObj.value);
  },

  /**
   * @return true if there is a selected message and it's an RSS feed message.
   */
  get selectedMessageIsFeed FolderDisplayWidget_get_selectedMessageIsFeed() {
    let message = this.selectedMessage;
    return Boolean(message && message.folder &&
                   message.folder.server.type == 'rss');
  },

  /**
   * @return true if there is a selected message and it's an IMAP message.
   */
  get selectedMessageIsImap FolderDisplayWidget_get_selectedMessageIsImap() {
    let message = this.selectedMessage;
    return Boolean(message && message.folder &&
                   message.folder.flags & nsMsgFolderFlags.ImapBox);
  },

  /**
   * @return true if there is a selected message and it's a news message.  It
   *  would be great if messages knew this about themselves, but they don't.
   */
  get selectedMessageIsNews FolderDisplayWidget_get_selectedMessageIsNews() {
    let message = this.selectedMessage;
    return Boolean(message && message.folder &&
                   (message.folder.flags & nsMsgFolderFlags.Newsgroup));
  },

  /**
   * @return true if there is a selected message and it's an external message,
   *  meaning it is loaded from an .eml file on disk or is an rfc822 attachment
   *  on a message.
   */
  get selectedMessageIsExternal
      FolderDisplayWidget_get_selectedMessageIsExternal() {
    let message = this.selectedMessage;
    // Dummy messages currently lack a folder.  This is not a great heuristic.
    // I have annotated msgHdrViewOverlay.js which provides the dummy header to
    //  express this implementation dependency.
    // (Currently, since external mails can only be opened in standalone windows
    //  which subclass us, we could always return false, and have the subclass
    //  return true using its own heuristics.  But since we are moving to a tab
    //  model more heavily, at some point the 3-pane will need this.)
    return Boolean(message && !message.folder);
  },

  /**
   * @return the number of selected messages.  If the
   *  "mail.operate_on_msgs_in_collapsed_threads" preference is enabled, then
   *  any collapsed thread roots that are selected will also conceptually have
   *  all of the messages in that thread selected.
   */
  get selectedCount FolderDisplayWidget_get_selectedCount() {
    if (!this.view.dbView)
      return 0;
    return this.view.dbView.numSelected;
  },

  /**
   * Provides a list of the view indices that are selected which is *not* the
   *  same as the rows of the selected messages.  When the
   *  "mail.operate_on_msgs_in_collapsed_threads" preference is enabled,
   *  messages may be selected but not visible (because the thread root is
   *  selected.)
   * You probably want to use the |selectedMessages| attribute instead of this
   *  one.  (Or selectedMessageUris in some rare cases.)
   *
   * If the user has right-clicked on a message, this will return that message
   *  and not the selection prior to the right-click.
   *
   * @return a list of the view indices that are currently selected
   */
  get selectedIndices FolderDisplayWidget_get_selectedIndices() {
    if (!this.view.dbView)
      return [];

    return this.view.dbView.getIndicesForSelection({});
  },

  /**
   * Provides a list of the message headers for the currently selected messages.
   *  If the "mail.operate_on_msgs_in_collapsed_threads" preference is enabled,
   *  then any collapsed thread roots that are selected will also (conceptually)
   *  have all of the messages in that thread selected and they will be included
   *  in the returned list.
   *
   * If the user has right-clicked on a message, this will return that message
   *  (and any collapsed children if so enabled) and not the selection prior to
   *  the right-click.
   *
   * @return a list of the message headers for the currently selected messages.
   *     If there are no selected messages, the result is an empty list.
   */
  get selectedMessages FolderDisplayWidget_get_selectedMessages() {
    if (!this.view.dbView)
      return [];
    // getMsgHdrsForSelection returns an nsIMutableArray.  We want our callers
    //  to have a user-friendly JS array and not have to worry about
    //  QueryInterfacing the values (or needing to know to use fixIterator).
    return [msgHdr for each
              (msgHdr in fixIterator(
                          this.view.dbView.getMsgHdrsForSelection().enumerate(),
                          Components.interfaces.nsIMsgDBHdr))];
  },

  /**
   * @return a list of the URIs for the currently selected messages or null
   *     (instead of a list) if there are no selected messages.  Do not
   *     pass around URIs unless you have a good reason.  Legacy code is an
   *     ok reason.
   *
   * If the user has right-clicked on a message, this will return that message's
   *  URI and not the selection prior to the right-click.
   */
  get selectedMessageUris FolderDisplayWidget_get_selectedMessageUris() {
    if (!this.view.dbView)
      return null;

    let messageArray = this.view.dbView.getURIsForSelection({});
    return messageArray.length ? messageArray : null;
  },

  /**
   * Clear the tree selection, making sure the message pane is cleared and
   *  the context display (toolbars, etc.) are updated.
   */
  clearSelection: function FolderDisplayWidget_clearSelection() {
    let treeSelection = this.treeSelection; // potentially magic getter
    if (!treeSelection)
      return;
    treeSelection.clearSelection();
    this.messageDisplay.clearDisplay();
    this._updateContextDisplay();
  },

  /**
   * Select a message for display by header.  If the view is active, attempt
   *  to select the message right now.  If the view is not active or we were
   *  unable to find it, update our saved selection to want to display the
   *  message.  Threads are expanded to find the header.
   *
   * @param aMsgHdr The message header to select for display.
   */
  selectMessage: function FolderDisplayWidget_selectMessage(aMsgHdr,
      aForceNotification) {
    if (this.active) {
      let viewIndex = this.view.dbView.findIndexOfMsgHdr(aMsgHdr, true);
      if (viewIndex != nsMsgViewIndex_None) {
        this.selectViewIndex(viewIndex);
        return;
      }
    }
    this._savedSelection = [{messageId: aMsgHdr.messageId}];
    // queue the selection to be restored once we become active if we are not
    //  active.
    if (!this.active)
      this._notifyWhenActive(this._restoreSelection);
  },

  /**
   * Select all of the provided nsIMsgDBHdrs in the aMessages array, expanding
   *  threads as required.  If the view is not active, or we were not able to
   *  find all of the messages, update our saved selection to want to display
   *  the messages.  The messages will then be selected when we are made active
   *  or all messages in the folder complete loading.  This is to accomodate the
   *  use-case where we are backed by an in-progress search and no
   *
   * @param aMessages An array of nsIMsgDBHdr instances.
   * @param aDoNotNeedToFindAll If true (can be omitted and left undefined), we
   *     do not attempt to save the selection for future use.  This is intended
   *     for use by the _restoreSelection call which is the end-of-the-line for
   *     restoring the selection.  (Once it gets called all of our messages
   *     should have already been loaded.)
   */
  selectMessages: function FolderDisplayWidget_selectMessages(
    aMessages, aDoNotNeedToFindAll) {
    if (this.active && this.treeSelection) {
      let foundAll = true;
      let treeSelection = this.treeSelection;
      let dbView = this.view.dbView;
      let minRow = null, maxRow = null;

      treeSelection.selectEventsSuppressed = true;
      treeSelection.clearSelection();

      for each (let [, msgHdr] in Iterator(aMessages)) {
        let viewIndex = dbView.findIndexOfMsgHdr(msgHdr, true);
        if (viewIndex != nsMsgViewIndex_None) {
          if (minRow == null || viewIndex < minRow)
            minRow = viewIndex;
          if (maxRow == null || viewIndex > maxRow )
            maxRow = viewIndex;
          // nsTreeSelection is actually very clever about doing this
          //  efficiently.
          treeSelection.rangedSelect(viewIndex, viewIndex, true);
        }
        else {
          foundAll = false;
        }

        // make sure the selection is as visible as possible
        if (minRow != null)
          this.ensureRowRangeIsVisible(minRow, maxRow);
      }

      treeSelection.selectEventsSuppressed = false;

      if (!aDoNotNeedToFindAll || foundAll)
        return;
    }
    this._savedSelection = [{messageId: msgHdr.messageId} for each
                            ([, msgHdr] in Iterator(aMessages))];
    if (!this.active)
      this._notifyWhenActive(this._restoreSelection);
  },

  /**
   * Select the message at view index.
   *
   * @param aViewIndex The view index to select.  This will be bounds-checked
   *     and if it is outside the bounds, we will clear the selection and
   *     bail.
   */
  selectViewIndex: function FolderDisplayWidget_selectViewIndex(aViewIndex) {
    let treeSelection = this.treeSelection;
    // if we have no selection, we can't select something
    if (!treeSelection)
      return;
    let rowCount = this.view.dbView.rowCount;
    if ((aViewIndex == nsMsgViewIndex_None) ||
        (aViewIndex < 0) || (aViewIndex >= rowCount)) {
      this.clearSelection();
      return;
    }

    // Check whether the index is already selected/current.  This can be the
    //  case when we are here as the result of a deletion.  Assuming
    //  nsMsgDBView::NoteChange ran and was not suppressing change
    //  notifications, then it's very possible the selection is already where
    //  we want it to go.  However, in that case, nsMsgDBView::SelectionChanged
    //  bailed without doing anything because m_deletingRows...
    // So we want to generate a change notification if that is the case. (And
    //  we still want to call ensureRowIsVisible, as there may be padding
    //  required.)
    if ((treeSelection.count == 1) &&
        ((treeSelection.currentIndex == aViewIndex) ||
         treeSelection.isSelected(aViewIndex))) {
      // Make sure the index we just selected is also the current index.
      //  This can happen when the tree selection adjusts itself as a result of
      //  changes to the tree as a result of deletion.  This will not trigger
      //  a notification.
      treeSelection.select(aViewIndex);
      this.view.dbView.selectionChanged();
    }
    // Previous code was concerned about avoiding updating commands on the
    //  assumption that only the selection count mattered.  We no longer
    //  make this assumption.
    // Things that may surprise you about the call to treeSelection.select:
    // 1) This ends up calling the onselect method defined on the XUL 'tree'
    //    tag.  For the 3pane this is the ThreadPaneSelectionChanged method in
    //    threadPane.js.  That code checks a global to see if it is dealing
    //    with a right-click, and ignores it if so.
    else {
      treeSelection.select(aViewIndex);
    }

    this.ensureRowIsVisible(aViewIndex);
  },

  /**
   * For every selected message in the display that is part of a (displayed)
   *  thread and is not the root message, de-select it and ensure that the
   *  root message of the thread is selected.
   * This is primarily intended to be used when collapsing visible threads.
   *
   * We do nothing if we are not in a threaded display mode.
   */
  selectSelectedThreadRoots:
      function FolderDisplayWidget_selectSelectedThreadRoots() {
    if (!this.view.showThreaded)
      return;

    // There are basically two implementation strategies available to us:
    // 1) For each selected view index with a level > 0, keep walking 'up'
    //    (numerically smaller) until we find a message with level 0.
    //    The inefficiency here is the potentially large number of JS calls
    //    into XPCOM space that will be required.
    // 2) Ask for the thread that each view index belongs to, use that to
    //    efficiently retrieve the thread root, then find the root using
    //    the message header.  The inefficiency here is that the view
    //    currently does a linear scan, albeit a relatively efficient one.
    // And the winner is... option 2, because the code is simpler because we
    //  can reuse selectMessages to do most of the work.
    let selectedIndices = this.selectedIndices;
    let newSelectedMessages = [];
    let dbView = this.view.dbView;
    for each (let [, index] in Iterator(selectedIndices)) {
      let thread = dbView.getThreadContainingIndex(index);
      // We use getChildHdrAt instead of getRootHdr because getRootHdr has
      //  a useless out-param and just calls getChildHdrAt anyways.
      newSelectedMessages.push(thread.getChildHdrAt(0));
    }
    this.selectMessages(newSelectedMessages);
  },

  /**
   * Number of padding messages before the 'focused' message when it is at the
   *  top of the thread pane.
   */
  TOP_VIEW_PADDING: 1,
  /**
   * Number of padding messages after the 'focused' message when it is at the
   *  bottom of the thread pane and lip padding does not apply.
   */
  BOTTOM_VIEW_PADDING: 1,

  /**
   * Ensure the given view index is visible, preferably with some padding.
   * By padding, we mean that the index will not be the first or last message
   *  displayed, but rather have messages on either side.
   * If we get near the end of the list of messages, we 'snap' to the last page
   *  of messages.  The intent is that we later implement a
   * We have the concept of a 'lip' when we are at the end of the message
   *  display.  If we are near the end of the display, we want to show an
   *  empty row (at the bottom) so the user knows they are at the end.  Also,
   *  if a message shows up that is new and things are sorted ascending, this
   *  turns out to be useful.
   */
  ensureRowIsVisible: function FolderDisplayWidget_ensureRowIsVisible(
      aViewIndex, aBounced) {
    // Dealing with the tree view layout is a nightmare, let's just always make
    //  sure we re-schedule ourselves.  The most particular rationale here is
    //  that the message pane may be toggling its state and it's much simpler
    //  and reliable if we ensure that all of FolderDisplayWidget's state
    //  change logic gets to run to completion before we run ourselves.
    if (!aBounced) {
      let dis = this;
      window.setTimeout(function() {
          dis.ensureRowIsVisible(aViewIndex, true);
        }, 0);
    }

    let treeBox = this.treeBox;
    if (!treeBox)
      return;

    // try and trigger a reflow...
    treeBox.height;

    let maxIndex = this.view.dbView.rowCount - 1;

    let first = treeBox.getFirstVisibleRow();
    // Assume the bottom row is half-visible and should generally be ignored.
    // (We could actually do the legwork to see if there is a partial one...)
    const halfVisible = 1;
    let last  = treeBox.getLastVisibleRow() - halfVisible;
    let span = treeBox.getPageLength() - halfVisible;

    let target;
    // If the index is near the end, try and latch on to the bottom.
    if (aViewIndex + span - this.TOP_VIEW_PADDING > maxIndex)
      target = maxIndex - span;
    // If the index is after the last visible guy (with padding), move down
    //  so that the target index is padded in 1 from the bottom.
    else if (aViewIndex >= last - this.BOTTOM_VIEW_PADDING)
      target = Math.min(maxIndex, aViewIndex + this.BOTTOM_VIEW_PADDING) -
                 span;
    // If the index is before the first visible guy (with padding), move up
    else if (aViewIndex <= first + this.TOP_VIEW_PADDING)  // move up
      target = Math.max(0, aViewIndex - this.TOP_VIEW_PADDING);
    else // it is already visible
      return;

    // this sets the first visible row
    treeBox.scrollToRow(target);
  },

  /**
   * Ensure that the given range of rows is visible maximally visible in the
   *  thread pane.  If the range is larger than the number of rows that can be
   *  displayed in the thread pane, we bias towards showing the min row (with
   *  padding).
   *
   * @param aMinRow The numerically smallest row index defining the start of
   *     the inclusive range.
   * @param aMaxRow The numberically largest row index defining the end of the
   *     inclusive range.
   */
  ensureRowRangeIsVisible:
      function FolderDisplayWidget_ensureRowRangeIsVisible(aMinRow, aMaxRow,
                                                           aBounced) {
    // Dealing with the tree view layout is a nightmare, let's just always make
    //  sure we re-schedule ourselves.  The most particular rationale here is
    //  that the message pane may be toggling its state and it's much simpler
    //  and reliable if we ensure that all of FolderDisplayWidget's state
    //  change logic gets to run to completion before we run ourselves.
    if (!aBounced) {
      let dis = this;
      window.setTimeout(function() {
          dis.ensureRowRangeIsVisible(aMinRow, aMaxRow, true);
        }, 0);
    }

    let treeBox = this.treeBox;
    if (!treeBox)
      return;
    let first = treeBox.getFirstVisibleRow();
    const halfVisible = 1;
    let last  = treeBox.getLastVisibleRow() - halfVisible;
    let span = treeBox.getPageLength() - halfVisible;

    // bail if the range is already visible with padding constraints handled
    if ((first + this.TOP_VIEW_PADDING <= aMinRow) &&
        (last - this.BOTTOM_VIEW_PADDING >= aMaxRow))
      return;

    let target;
    // if the range is bigger than we can fit, optimize position for the min row
    //  with padding to make it obvious the range doesn't extend above the row.
    if (aMaxRow - aMinRow > span)
      target = Math.max(0, aMinRow - this.TOP_VIEW_PADDING);
    // So the range must fit, and it's a question of how we want to position it.
    // For now, the answer is we try and center it, why not.
    else {
      let rowSpan = aMaxRow - aMinRow + 1;
      let halfSpare = parseInt((span - rowSpan - this.TOP_VIEW_PADDING -
                                this.BOTTOM_VIEW_PADDING) / 2);
      target = aMinRow - halfSpare - this.TOP_VIEW_PADDING;
    }
    treeBox.scrollToRow(target);
  },

  /**
   * Ensure that the selection is visible to the extent possible.
   */
  ensureSelectionIsVisible:
      function FolderDisplayWidget_ensureSelectionIsVisible() {
    let treeSelection = this.treeSelection; // potentially magic getter
    if (!treeSelection || !treeSelection.count)
      return;

    let minRow = null, maxRow = null;

    let rangeCount = treeSelection.getRangeCount();
    for (let iRange = 0; iRange < rangeCount; iRange++) {
      let rangeMinObj = {}, rangeMaxObj = {};
      treeSelection.getRangeAt(iRange, rangeMinObj, rangeMaxObj);
      let rangeMin = rangeMinObj.value, rangeMax = rangeMaxObj.value;
      if (minRow == null || rangeMin < minRow)
        minRow = rangeMin;
      if (maxRow == null || rangeMax > maxRow )
        maxRow = rangeMax;
    }

    this.ensureRowRangeIsVisible(minRow, maxRow);
  }
};

/**
 * Implement a fake nsITreeBoxObject so that we can keep the view
 *  nsITreeSelection selections 'live' when they are in the background.  We need
 *  to do this because nsTreeSelection changes its behaviour (and gets ornery)
 *  if it does not have a box object.
 * This does not need to exist once we abandon multiplexed tabbing.
 *
 * Sometimes, nsTreeSelection tries to turn us into an nsIBoxObject and then in
 *  turn get the associated element, and then create DOM events on that.  We
 *  can't really stop that, but we can use misdirection to tell it about a box
 *  object that we don't care about.  That way it gets the bogus events,
 *  effectively blackholing them.
 */
function FakeTreeBoxObject(aDummyBoxObject) {
  this.dummyBoxObject = aDummyBoxObject.QueryInterface(
                          Components.interfaces.nsIBoxObject);
  this.view = null;
}
FakeTreeBoxObject.prototype = {
  view: null,
  /**
   * No need to actually invalidate, as when we re-root the view this will
   *  happen.
   */
  invalidate: function FakeTreeBoxObject_invalidate() {
    // NOP
  },
  invalidateRange: function FakeTreeBoxObject_invalidateRange() {
    // NOP
  },
  invalidateRow: function FakeTreeBoxObject_invalidateRow() {
    // NOP
  },
  beginUpdateBatch: function FakeTreeBoxObject_beginUpdateBatch() {

  },
  endUpdateBatch: function FakeTreeBoxObject_endUpdateBatch() {

  },
  rowCountChanged: function FakeTreeBoxObject_rowCountChanged() {

  },
  /**
   * Sleight of hand!  If someone asks us about an nsIBoxObject, we tell them
   *  about a real box object that is just a dummy and is never used for
   *  anything.
   */
  QueryInterface: function FakeTreeBoxObject_QueryInterface(aIID) {
    if (aIID.equals(Components.interfaces.nsIBoxObject))
      return this.dummyBoxObject;
    if (!aIID.equals(Components.interfaces.nsISupports) &&
        !aIID.equals(Components.interfaces.nsITreeBoxObject))
      throw Components.results.NS_ERROR_NO_INTERFACE;
    return this;
  }
};
/*
 * Provide attribute and function implementations that complain very loudly if
 *  they are used.  Now, XPConnect will return an error to callers if we don't
 *  implement part of the interface signature, but this is unlikely to provide
 *  the visibility we desire.  In fact, since it is a simple nsresult error,
 *  it may make things completely crazy.  So this way we can yell via dump,
 *  throw an exception, etc.
 */
function FTBO_stubOutAttributes(aObj, aAttribNames) {
  for (let [, attrName] in Iterator(aAttribNames)) {
    let myAttrName = attrName;
    aObj.__defineGetter__(attrName,
      function() {
        let msg = "Read access to stubbed attribute " + myAttrName;
        dump(msg + "\n");
        debugger;
        throw new Error(msg);
      });
    aObj.__defineSetter__(attrName,
      function() {
        let msg = "Write access to stubbed attribute " + myAttrName;
        dump(msg + "\n");
        debugger;
        throw new Error(msg);
      });
  }
}
function FTBO_stubOutMethods(aObj, aMethodNames) {
  for (let [, methodName] in Iterator(aMethodNames)) {
    let myMethodName = methodName;
    aObj[myMethodName] = function() {
      let msg = "Call to stubbed method " + myMethodName;
      dump(msg + "\n");
      debugger;
      throw new Error(msg);
    };
  }
}
FTBO_stubOutAttributes(FakeTreeBoxObject.prototype, [
  "columns",
  "focused",
  "treeBody",
  "rowHeight",
  "rowWidth",
  "horizontalPosition",
  "selectionRegion",
  ]);
FTBO_stubOutMethods(FakeTreeBoxObject.prototype, [
  "getFirstVisibleRow",
  "getLastVisibleRow",
  "getPageLength",
  "ensureRowIsVisible",
  "ensureCellIsVisible",
  "scrollToRow",
  "scrollByLines",
  "scrollByPages",
  "scrollToCell",
  "scrollToColumn",
  "scrollToHorizontalPosition",
  "invalidateColumn",
  "invalidateRow",
  "invalidateCell",
  "invalidateColumnRange",
  "getRowAt",
  "getCellAt",
  "getCoordsForCellItem",
  "isCellCropped",
  "clearStyleAndImageCaches",
  ]);