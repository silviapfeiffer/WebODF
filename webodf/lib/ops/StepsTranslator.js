/**
 * @license
 * Copyright (C) 2012-2013 KO GmbH <copyright@kogmbh.com>
 *
 * @licstart
 * The JavaScript code in this page is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License
 * (GNU AGPL) as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.  The code is distributed
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU AGPL for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this code.  If not, see <http://www.gnu.org/licenses/>.
 *
 * As additional permission under GNU AGPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * As a special exception to the AGPL, any HTML file which merely makes function
 * calls to this code, and for that purpose includes it by reference shall be
 * deemed a separate work for copyright law purposes. In addition, the copyright
 * holders of this code give you permission to combine this code with free
 * software libraries that are released under the GNU LGPL. You may copy and
 * distribute such a system following the terms of the GNU AGPL for this code
 * and the LGPL for the libraries. If you modify this code, you may extend this
 * exception to your version of the code, but you are not obligated to do so.
 * If you do not wish to do so, delete this exception statement from your
 * version.
 *
 * This license applies to this entire compilation.
 * @licend
 * @source: http://www.webodf.org/
 * @source: https://github.com/kogmbh/WebODF/
 */

/*global runtime, core, ops, odf, Node*/



(function () {
    "use strict";
    // Multiple cached translators may exist in the same runtime. Therefore, each node id should
    // be globally unique, so they can be safely re-used by multiple translators
    var /**@type{number}*/
        nextNodeId = 0,
        /**
         * @const
         * @type {!number}
         */
        PREVIOUS_STEP = 0,
        /**
         * @const
         * @type {!number}
         */
        NEXT_STEP = 1;

    /**
     * Implementation of a step to DOM point lookup cache.
     *
     * A cache point is created for each passed paragraph, saving the number of steps from the root node to the first
     * walkable position in the paragraph. This cached point is linked to the paragraph node via a unique identifier
     * per node.
     *
     * This cache depends on StepsTranslator.handleStepsInserted & handleStepsRemoved is called at the step of change,
     * along with information about how many steps have been changed. The cache is able to cope with paragraph nodes being
     * cloned, as long as the position of change and reported number of steps changed is correctly reported.
     *
     * However, this implementation will NOT cope with paragraphs being re-ordered, even if a change event is reported.
     * This is because the cache relies on the paragraph order remaining fixed as long as they are in the DOM.
     * If paragraph reordering is desired, it can be achieved through either:
     * a) cloning the paragraph into the new position and removing the original paragraph (the clone will be detected and rectified)
     * b) removing the original paragraph from the DOM, calling updateCache (to purge the original bookmark) then re-adding
     *      the paragraph into the new position and calling updateCache a second time (add a brand new bookmark for the paragraph)
     *
     * When updateCacheAtPoint is called, the cache will refresh all bookmarks trailing the removal/insertion step. Note,
     * the exact step of change is not affected. For example, inserting 2 steps after position 9 results in the following
     * changes to existing points:
     * 9 => 9
     * 10 => 12
     * 11 => 13
     * ...
     *
     * Removing 2 steps from after position 9 results in the following:
     * 9 => 9
     * 10 => x
     * 11 => x
     * 12 => 10
     * 13 => 11
     * ...
     *
     * @param {!Node} rootNode
     * @param {!core.PositionFilter} filter
     * @param {!number} bucketSize  Minimum number of steps between cache points
     * @constructor
     */
    function StepsCache(rootNode, filter, bucketSize) {
        var coordinatens = "urn:webodf:names:steps",
            /**@type{!Object.<(!string|!number), !ParagraphBookmark>}*/
            stepToDomPoint = {},
            /**@type{!Object.<!string, !ParagraphBookmark>}*/
            nodeToBookmark = {},
            odfUtils = new odf.OdfUtils(),
            domUtils = new core.DomUtils(),
            /**@type{!RootBookmark}*/
            basePoint,
            /**@const*/
            FILTER_ACCEPT = core.PositionFilter.FilterResult.FILTER_ACCEPT;

        /**
         * Bookmark indicating the first walkable position in a paragraph
         * @constructor
         * @param {!number} steps
         * @param {!Element} paragraphNode
         */
        function ParagraphBookmark(steps, paragraphNode) {
            this.steps = steps;
            this.node = paragraphNode;

            /**
             * @param {!core.PositionIterator} iterator
             * @return {undefined}
             */
            this.setIteratorPosition = function(iterator) {
                iterator.setPositionBeforeElement(paragraphNode);
                do {
                    if (filter.acceptPosition(iterator) === FILTER_ACCEPT) {
                        break;
                    }
                } while (iterator.nextPosition());
            };
        }

        /**
         * Bookmark indicating the first walkable position in the document
         * @param {!number} steps
         * @param {!Node} rootNode
         * @constructor
         */
        function RootBookmark(steps, rootNode) {
            this.steps = steps;
            this.node = rootNode;

            /**
             * @param {!core.PositionIterator} iterator
             * @return {undefined}
             */
            this.setIteratorPosition = function (iterator) {
                iterator.setUnfilteredPosition(rootNode, 0);
                do {
                    if (filter.acceptPosition(iterator) === FILTER_ACCEPT) {
                        break;
                    }
                } while (iterator.nextPosition());
            };
        }

        /**
         * Returns the closest quantized step at or before the requested step
         * @param {!number} steps
         * @return {!number}
         */
        function getBucket(steps) {
            return Math.floor(steps / bucketSize) * bucketSize;
        }

        /**
         * Returns the closest quantized step at or just after the requested step
         * @param {!number} steps
         * @return {!number}
         */
        function getDestinationBucket(steps) {
            return Math.ceil(steps / bucketSize) * bucketSize;
        }

        /**
         * @param {!Element} node
         * @return {undefined}
         */
        function clearNodeId(node) {
            node.removeAttributeNS(coordinatens, "nodeId");
        }

        /**
         * @param {!Node} node
         * @return {string}
         */
        function getNodeId(node) {
            var id = "";
            if (node.nodeType === Node.ELEMENT_NODE) {
                id = /**@type{!Element}*/(node).getAttributeNS(coordinatens, "nodeId");
            }
            return id;
        }

        /**
         * @param {!Element} node
         * @return {!string}
         */
        function setNodeId(node) {
            var nodeId = nextNodeId.toString();
            node.setAttributeNS(coordinatens, "nodeId", nodeId);
            nextNodeId += 1;
            return nodeId;
        }

        /**
         * The element might have been cloned from another part of the document and have a stale or duplicate
         * nodeId
         * @param {!Node} node
         * @param {!ParagraphBookmark|!RootBookmark} bookmark
         * @return {!boolean} True if the bookmark is actually for the supplied node
         */
        function isValidBookmarkForNode(node, bookmark) {
            return bookmark.node === node;
        }

        /**
         * Fetches (or creates) a bookmark for the specified node. The bookmark's steps
         * are updated to the specified number of steps
         * @param {!Element} node
         * @param {!number} steps
         * @return {!ParagraphBookmark}
         */
        function getNodeBookmark(node, steps) {
            var nodeId = getNodeId(node) || setNodeId(node),
                existingBookmark;
            existingBookmark = nodeToBookmark[nodeId];
            if (!existingBookmark) {
                existingBookmark = nodeToBookmark[nodeId] = new ParagraphBookmark(steps, node);
            } else if (!isValidBookmarkForNode(node, existingBookmark)) {
                runtime.log("Cloned node detected. Creating new bookmark");
                nodeId = setNodeId(node);
                existingBookmark = nodeToBookmark[nodeId] = new ParagraphBookmark(steps, node);
            } else {
                existingBookmark.steps = steps;
            }
            return existingBookmark;
        }

        /**
         * Process known step to DOM position points for possible caching
         * @param {!number} steps Current steps offset from position 0
         * @param {!core.PositionIterator} iterator
         * @param {!boolean} isStep True if the current node and offset is accepted by the position filter
         * @return {undefined}
         */
        this.updateCache = function(steps, iterator, isStep) {
            var stablePoint,
                cacheBucket,
                existingCachePoint,
                bookmark,
                node = iterator.getCurrentNode();

            if (iterator.isBeforeNode() && odfUtils.isParagraph(node)) {
                stablePoint = true;
                if (!isStep) {
                    // Paragraph bookmarks indicate "first position in the paragraph"
                    // If the current stable point is before the first walkable position (as often happens)
                    // simply increase the step number by 1 to move to within the paragraph node
                    steps += 1;
                }
            }

            if (stablePoint) {
                // E.g., steps <= 500 are valid for a request starting at 500 and counting forward
                bookmark = getNodeBookmark(/**@type{!Element}*/(node), steps);
                cacheBucket = getDestinationBucket(bookmark.steps);
                existingCachePoint = stepToDomPoint[cacheBucket];
                if (!existingCachePoint || bookmark.steps > existingCachePoint.steps) {
                    // The current node & offset are closer to the cache bucket boundary than the existing entry is
                    stepToDomPoint[cacheBucket] = bookmark;
                }
            }
        };

        /**
         * Set the iterator to the closest known position before or at the requested step, returning the number of steps
         * from position 0.
         * @param {!number} steps
         * @param {!core.PositionIterator} iterator
         * @return {!number} Corresponding step for the current iterator position
         */
        this.setToClosestStep = function (steps, iterator) {
            var cacheBucket = getBucket(steps),
                cachePoint;

            while (!cachePoint && cacheBucket !== 0) {
                cachePoint = stepToDomPoint[cacheBucket];
                cacheBucket -= bucketSize;
            }

            cachePoint = cachePoint || basePoint;
            cachePoint.setIteratorPosition(iterator);
            return cachePoint.steps;
        };

        /**
         * Finds the nearest ancestor node that has an associated bookmark
         * @param {!Node} node
         * @return {?ParagraphBookmark}
         */
        function findBookmarkedAncestor(node) {
            var currentNode = node,
                nodeId,
                bookmark = null;

            while (!bookmark && currentNode && currentNode !== rootNode) {
                nodeId = getNodeId(currentNode);
                if (nodeId) {
                    // Take care as a nodeId may be bookmarked in another translator, but not this particular instance
                    // Keep crawling up the hierarchy until a node is found with a node id AND bookmark in this translator
                    bookmark = nodeToBookmark[nodeId];
                    if (bookmark && !isValidBookmarkForNode(currentNode, bookmark)) {
                        runtime.log("Cloned node detected. Creating new bookmark");
                        bookmark = null;
                        clearNodeId(/**@type{!Element}*/(currentNode));
                    }
                }
                currentNode = currentNode.parentNode;
            }
            return bookmark;
        }

        /**
         * Set the iterator to the closest known position before or at the requested node & offset, returning the number
         * of steps from position 0.
         * @param {!Node} node
         * @param {!number} offset
         * @param {!core.PositionIterator} iterator
         * @return {!number} Corresponding step for the current iterator position
         */
        this.setToClosestDomPoint = function (node, offset, iterator) {
            var /**@type{!RootBookmark|?ParagraphBookmark}*/
                bookmark,
                b,
                /**@type{string|number}*/
                key;

            if (node === rootNode && offset === 0) {
                bookmark = basePoint;
            } else if (node === rootNode && offset === rootNode.childNodes.length) {
                bookmark = basePoint;
                for (key in stepToDomPoint) {
                    if (stepToDomPoint.hasOwnProperty(key)) {
                        b = stepToDomPoint[key];
                        if (b.steps > bookmark.steps) {
                            bookmark = b;
                        }
                    }
                }
            } else {
                bookmark = findBookmarkedAncestor(node.childNodes.item(offset) || node);
                if (!bookmark) {
                    // No immediate bookmark was found, so crawl backwards using the iterator and try and find a known position
                    iterator.setUnfilteredPosition(node, offset);
                    while (!bookmark && iterator.previousNode()) {
                        bookmark = findBookmarkedAncestor(iterator.getCurrentNode());
                    }
                }
            }

            bookmark = bookmark || basePoint;
            bookmark.setIteratorPosition(iterator);
            return bookmark.steps;
        };

        /**
         * Update all cached bookmarks starting just beyond the specified step
         * @param {!number} inflectionStep Step beyond which the changes occurs. Bookmarks beyond step+1 will be updated
         * @param {!function(number):number} getUpdatedSteps Callback to get an updated number of bookmark steps
         * @return {undefined}
         */
        this.updateCacheAtPoint = function (inflectionStep, getUpdatedSteps) {
            var affectedBookmarks = [],
                /**@type{!Object.<(string|number),!ParagraphBookmark>}*/
                updatedBuckets = {},
                /**@type{string}*/
                key,
                bookmark;

            // Key concept: on step removal, the inflectionStep is replaced by the following step.
            // In the case of paragraph removal, this means the bookmark at exactly the point of inflection might be replaced.

            for (key in nodeToBookmark) {
                if (nodeToBookmark.hasOwnProperty(key)) {
                    bookmark = nodeToBookmark[key];
                    if (bookmark.steps > inflectionStep) {
                        affectedBookmarks.push(bookmark);
                    }
                }
            }

            /**
             * @param {!ParagraphBookmark} bookmark
             * @return {undefined}
             */
            function handle(bookmark) {
                var originalCacheBucket = getDestinationBucket(bookmark.steps),
                    newCacheBucket,
                    existingBookmark;

                if (domUtils.containsNode(rootNode, bookmark.node)) {
                    bookmark.steps = getUpdatedSteps(bookmark.steps);
                    // The destination cache bucket might have updated as a result of the bookmark update
                    newCacheBucket = getDestinationBucket(bookmark.steps);
                    existingBookmark = updatedBuckets[newCacheBucket];
                    if (!existingBookmark || bookmark.steps > existingBookmark.steps) {
                        // Use this bookmark if it is either the only one in the cache bucket, or the closest
                        updatedBuckets[newCacheBucket] = bookmark;
                    }
                } else {
                    // Node is no longer present in the document
                    delete nodeToBookmark[getNodeId(bookmark.node)];
                }
                if (stepToDomPoint[originalCacheBucket] === bookmark) {
                    // The new cache entry will be added in the subsequent update
                    delete stepToDomPoint[originalCacheBucket];
                }
            }
            affectedBookmarks.forEach(handle);

            Object.keys(updatedBuckets).forEach(function (cacheBucket) {
                stepToDomPoint[cacheBucket] = updatedBuckets[cacheBucket];
            });
        };

        function init() {
            basePoint = new RootBookmark(0, rootNode);
        }
        init();
    }

    /**
     *
     * @constructor
     * @param {!function():!Node} getRootNode
     * @param {!function(!Node):!core.PositionIterator} newIterator
     * @param {!core.PositionFilter} filter
     * @param {!number} bucketSize  Minimum number of steps between cache points
     */
    ops.StepsTranslator = function StepsTranslator(getRootNode, newIterator, filter, bucketSize) {
        var rootNode = getRootNode(),
            /**@type{!StepsCache}*/
            stepsCache = new StepsCache(rootNode, filter, bucketSize),
            domUtils = new core.DomUtils(),
            /**@type{!core.PositionIterator}*/
            iterator = newIterator(getRootNode()),
            /**@const*/
            FILTER_ACCEPT = core.PositionFilter.FilterResult.FILTER_ACCEPT;

        /**
         * This evil little check is necessary because someone, not mentioning any names *cough*
         * added an extremely hacky undo manager that replaces the root node in order to go back
         * to a prior document state.
         * This makes things very sad, and kills baby kittens.
         * Unfortunately, no-one has had time yet to write a *real* undo stack... so we just need
         * to cope with it for now.
         * @return {undefined}
         */
        function verifyRootNode() {
            // TODO Remove when a proper undo manager arrives
            var currentRootNode = getRootNode();
            if (currentRootNode !== rootNode) {
                runtime.log("Undo detected. Resetting steps cache");
                rootNode = currentRootNode;
                stepsCache = new StepsCache(rootNode, filter, bucketSize);
                iterator = newIterator(rootNode);
            }
        }

        /**
         * Convert the requested steps from root into the equivalent DOM node & offset pair. If the
         * requested step is before the start or past the end of the document, a RangeError will be thrown.
         * @param {!number} steps
         * @return {!{node: !Node, offset: !number}}
         */
        this.convertStepsToDomPoint = function (steps) {
            var /**@type{!number}*/
                stepsFromRoot,
                isStep;

            if (isNaN(steps)) {
                throw new TypeError("Requested steps is not numeric (" + steps + ")");
            }
            if (steps < 0) {
                throw new RangeError("Requested steps is negative (" + steps + ")");
            }
            verifyRootNode();
            stepsFromRoot = stepsCache.setToClosestStep(steps, iterator);
            
            while (stepsFromRoot < steps && iterator.nextPosition()) {
                isStep = filter.acceptPosition(iterator) === FILTER_ACCEPT;
                if (isStep) {
                    stepsFromRoot += 1;
                }
                stepsCache.updateCache(stepsFromRoot, iterator, isStep);
            }
            if (stepsFromRoot !== steps) {
                throw new RangeError("Requested steps (" + steps + ") exceeds available steps (" + stepsFromRoot + ")");
            }
            return {
                node: iterator.container(),
                offset: iterator.unfilteredDomOffset()
            };
        };

        /**
         * Uses the provided delegate to choose between rounding up or rounding down to the nearest step.
         * @param {!core.PositionIterator} iterator
         * @param {function(!number, !Node, !number):boolean=} roundDirection
         * @return {!boolean} Returns true if an accepted position is found, otherwise returns false.
         */
        function roundToPreferredStep(iterator, roundDirection) {
            if (!roundDirection || filter.acceptPosition(iterator) === FILTER_ACCEPT) {
                return true;
            }

            while (iterator.previousPosition()) {
                if (filter.acceptPosition(iterator) === FILTER_ACCEPT) {
                    if (roundDirection(PREVIOUS_STEP, iterator.container(), iterator.unfilteredDomOffset())) {
                        return true;
                    }
                    break;
                }
            }

            while (iterator.nextPosition()) {
                if (filter.acceptPosition(iterator) === FILTER_ACCEPT) {
                    if (roundDirection(NEXT_STEP, iterator.container(), iterator.unfilteredDomOffset())) {
                        return true;
                    }
                    break;
                }
            }

            return false;
        }

        /**
         * Convert the supplied DOM node & offset pair into it's equivalent steps from root
         * If the node & offset is not in an accepted location, the
         * roundDirection delegate is used to choose between rounding up or
         * rounding down to the nearest step. If not provided, the default
         * behaviour is to round down.
         * @param {!Node} node
         * @param {!number} offset
         * @param {function(!number, !Node, !number):!boolean=} roundDirection
         * @return {!number}
         */
        this.convertDomPointToSteps = function (node, offset, roundDirection) {
            var stepsFromRoot,
                beforeRoot,
                destinationNode,
                destinationOffset,
                rounding = 0,
                isStep;

            verifyRootNode();
            if (!domUtils.containsNode(rootNode, node)) {
                beforeRoot = domUtils.comparePoints(rootNode, 0, node, offset) < 0;
                node = /**@type{!Node}*/(rootNode);
                offset = beforeRoot ? 0 : /**@type{!Element}*/(rootNode).childNodes.length;
            }

            iterator.setUnfilteredPosition(node, offset);
            // if the user has set provided a rounding selection delegate, use that to select the previous or next
            // step if the (node, offset) position is not accepted by the filter
            if (!roundToPreferredStep(iterator, roundDirection)) {
                // The rounding selection delegate rejected both. Revert back to the previous step
                iterator.setUnfilteredPosition(node, offset);
            }

            // Get the iterator equivalent position of the current node & offset
            // This ensures the while loop will match the exact container and offset during iteration
            destinationNode = iterator.container();
            destinationOffset = iterator.unfilteredDomOffset();

            stepsFromRoot = stepsCache.setToClosestDomPoint(destinationNode, destinationOffset, iterator);
            if (domUtils.comparePoints(iterator.container(), iterator.unfilteredDomOffset(), destinationNode, destinationOffset) < 0) {
                // Special case: the requested DOM point is between the bookmark node and walkable step it represents
                return stepsFromRoot > 0 ? stepsFromRoot - 1 : stepsFromRoot;
            }

            while (!(iterator.container() === destinationNode && iterator.unfilteredDomOffset() === destinationOffset)
                    && iterator.nextPosition()) {
                isStep = filter.acceptPosition(iterator) === FILTER_ACCEPT;
                if (isStep) {
                    stepsFromRoot += 1;
                }
                stepsCache.updateCache(stepsFromRoot, iterator, isStep);
            }
            return stepsFromRoot + rounding;
        };

        /**
         * Iterates over all available positions starting at the root node and primes the cache
         * @return {undefined}
         */
        this.prime = function () {
            var stepsFromRoot,
                isStep;

            verifyRootNode();
            stepsFromRoot = stepsCache.setToClosestStep(0, iterator);
            while (iterator.nextPosition()) {
                isStep = filter.acceptPosition(iterator) === FILTER_ACCEPT;
                if (isStep) {
                    stepsFromRoot += 1;
                }
                stepsCache.updateCache(stepsFromRoot, iterator, isStep);
            }
        };

        /**
         * @param {!{position: !number, length: !number}} eventArgs
         * @return {undefined}
         */
        this.handleStepsInserted = function (eventArgs) {
            verifyRootNode();
            // Old position = position
            // New position = position + length
            // E.g., {position: 10, length: 1} indicates 10 => 10, New => 11, 11 => 12, 12 => 13
            /**
             * @param {number} steps
             * @return {number}
             */
            function doUpdate(steps) {
                return steps + eventArgs.length;
            }
            stepsCache.updateCacheAtPoint(eventArgs.position, doUpdate);
        };

        /**
         * @param {!{position: !number, length: !number}} eventArgs
         * @return {undefined}
         */
        this.handleStepsRemoved = function (eventArgs) {
            verifyRootNode();
            // Old position = position + length
            // New position = position
            // E.g., {position: 10, length: 1} indicates 10 => 10, 11 => 10, 12 => 11
            /**
             * @param {number} steps
             * @return {number}
             */
            function doUpdate(steps) {
                steps -= eventArgs.length;
                if (steps < 0) {
                    // Obviously, there can't be negative steps in a document
                    steps = 0;
                }
                return steps;
            }
            stepsCache.updateCacheAtPoint(eventArgs.position, doUpdate);
        };
    };

    /**
     * @const
     * @type {!number}
     */
    ops.StepsTranslator.PREVIOUS_STEP = PREVIOUS_STEP;

    /**
     * @const
     * @type {!number}
     */
    ops.StepsTranslator.NEXT_STEP = NEXT_STEP;

    return ops.StepsTranslator;
}());
