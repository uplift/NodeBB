'use strict';


define('forum/topic', [
	'forum/infinitescroll',
	'forum/topic/threadTools',
	'forum/topic/postTools',
	'forum/topic/events',
	'forum/topic/posts',
	'forum/topic/images',
	'navigator',
	'sort',
	'components',
	'storage',
	'hooks',
], function (
	infinitescroll, threadTools, postTools,
	events, posts, images, navigator, sort,
	components, storage, hooks
) {
	var	Topic = {};
	var currentUrl = '';

	$(window).on('action:ajaxify.start', function (ev, data) {
		if (Topic.replaceURLTimeout) {
			clearTimeout(Topic.replaceURLTimeout);
			Topic.replaceURLTimeout = 0;
		}
		events.removeListeners();

		if (!String(data.url).startsWith('topic/')) {
			navigator.disable();
			components.get('navbar/title').find('span').text('').hide();
			app.removeAlert('bookmark');

			require(['search'], function (search) {
				if (search.topicDOM.active) {
					search.topicDOM.end();
				}
			});
		}
	});

	Topic.init = function () {
		var tid = ajaxify.data.tid;
		currentUrl = ajaxify.currentPage;
		hooks.fire('action:topic.loading');

		app.enterRoom('topic_' + tid);

		posts.onTopicPageLoad(components.get('post'));

		navigator.init('[component="post"]', ajaxify.data.postcount, Topic.toTop, Topic.toBottom, Topic.navigatorCallback);

		postTools.init(tid);
		threadTools.init(tid, $('.topic'));
		events.init();

		sort.handleSort('topicPostSort', 'topic/' + ajaxify.data.slug);

		if (!config.usePagination) {
			infinitescroll.init($('[component="topic"]'), posts.loadMorePosts);
		}

		addBlockQuoteHandler();
		addParentHandler();
		addDropupHandler();
		addRepliesHandler();



		handleBookmark(tid);

		$(window).on('scroll', updateTopicTitle);

		handleTopicSearch();
		app.showEmailConfirmWarning();

		hooks.fire('action:topic.loaded', ajaxify.data);
	};

	function handleTopicSearch() {
		$('.topic-search').off('click')
			.on('click', '.prev', function () {
				require(['search'], function (search) {
					search.topicDOM.prev();
				});
			})
			.on('click', '.next', function () {
				require(['search'], function (search) {
					search.topicDOM.next();
				});
			});

		if (config.topicSearchEnabled) {
			require(['mousetrap'], function (mousetrap) {
				mousetrap.bind(['command+f', 'ctrl+f'], function (e) {
					var match = ajaxify.currentPage.match(/^topic\/([\d]+)/);
					var tid;
					if (match) {
						e.preventDefault();
						tid = match[1];
						$('#search-fields input').val('in:topic-' + tid + ' ');
						app.prepareSearch();
					}
				});
			});
		}
	}

	Topic.toTop = function () {
		navigator.scrollTop(0);
	};

	Topic.toBottom = function () {
		socket.emit('topics.postcount', ajaxify.data.tid, function (err, postCount) {
			if (err) {
				return app.alertError(err.message);
			}

			navigator.scrollBottom(postCount - 1);
		});
	};

	function handleBookmark(tid) {
		if (window.location.hash) {
			var el = $(utils.escapeHTML(window.location.hash));
			if (el.length) {
				return navigator.scrollToElement(el, true, 0);
			}
		}
		var bookmark = ajaxify.data.bookmark || storage.getItem('topic:' + tid + ':bookmark');
		var postIndex = ajaxify.data.postIndex;

		if (postIndex > 1) {
			if (components.get('post/anchor', postIndex - 1).length) {
				return navigator.scrollToPostIndex(postIndex - 1, true, 0);
			}
		} else if (bookmark && (
			!config.usePagination ||
			(config.usePagination && ajaxify.data.pagination.currentPage === 1)
		) && ajaxify.data.postcount > ajaxify.data.bookmarkThreshold) {
			app.alert({
				alert_id: 'bookmark',
				message: '[[topic:bookmark_instructions]]',
				timeout: 0,
				type: 'info',
				clickfn: function () {
					navigator.scrollToIndex(parseInt(bookmark, 10), true);
				},
				closefn: function () {
					storage.removeItem('topic:' + tid + ':bookmark');
				},
			});
			setTimeout(function () {
				app.removeAlert('bookmark');
			}, 10000);
		}
	}

	function addBlockQuoteHandler() {
		components.get('topic').on('click', 'blockquote .toggle', function () {
			var blockQuote = $(this).parent('blockquote');
			var toggle = $(this);
			blockQuote.toggleClass('uncollapsed');
			var collapsed = !blockQuote.hasClass('uncollapsed');
			toggle.toggleClass('fa-angle-down', collapsed).toggleClass('fa-angle-up', !collapsed);
		});
	}

	function addParentHandler() {
		components.get('topic').on('click', '[component="post/parent"]', function (e) {
			var toPid = $(this).attr('data-topid');

			var toPost = $('[component="topic"]>[component="post"][data-pid="' + toPid + '"]');
			if (toPost.length) {
				e.preventDefault();
				navigator.scrollToIndex(toPost.attr('data-index'), true);
				return false;
			}
		});
	}

	function addDropupHandler() {
		// Locate all dropdowns
		var target = $('#content .dropdown-menu').parent();

		// Toggle dropup if past 50% of screen
		$(target).on('show.bs.dropdown', function () {
			var dropUp = this.getBoundingClientRect().top > ($(window).height() / 2);
			$(this).toggleClass('dropup', dropUp);
		});
	}

	function addRepliesHandler() {
		$('[component="topic"]').on('click', '[component="post/reply-count"]', function () {
			var btn = $(this);
			require(['forum/topic/replies'], function (replies) {
				replies.init(btn);
			});
		});
	}

	function updateTopicTitle() {
		var span = components.get('navbar/title').find('span');
		if ($(window).scrollTop() > 50 && span.hasClass('hidden')) {
			span.html(ajaxify.data.title).removeClass('hidden');
		} else if ($(window).scrollTop() <= 50 && !span.hasClass('hidden')) {
			span.html('').addClass('hidden');
		}
		if ($(window).scrollTop() > 300) {
			app.removeAlert('bookmark');
		}
	}

	Topic.navigatorCallback = function (index, elementCount) {
		var path = ajaxify.removeRelativePath(window.location.pathname.slice(1));
		if (!path.startsWith('topic')) {
			return;
		}

		if (navigator.scrollActive) {
			return;
		}

		var newUrl = 'topic/' + ajaxify.data.slug + (index > 1 ? ('/' + index) : '');
		if (newUrl !== currentUrl) {
			if (Topic.replaceURLTimeout) {
				clearTimeout(Topic.replaceURLTimeout);
				Topic.replaceURLTimeout = 0;
			}
			currentUrl = newUrl;
			Topic.replaceURLTimeout = setTimeout(function () {
				if (index >= elementCount && app.user.uid) {
					socket.emit('topics.markAsRead', [ajaxify.data.tid]);
				}

				updateUserBookmark(index);

				Topic.replaceURLTimeout = 0;
				if (ajaxify.data.updateUrlWithPostIndex && history.replaceState) {
					var search = window.location.search || '';
					if (!config.usePagination) {
						search = (search && !/^\?page=\d+$/.test(search) ? search : '');
					}

					history.replaceState({
						url: newUrl + search,
					}, null, window.location.protocol + '//' + window.location.host + config.relative_path + '/' + newUrl + search);
				}
			}, 500);
		}
	};

	function updateUserBookmark(index) {
		var bookmarkKey = 'topic:' + ajaxify.data.tid + ':bookmark';
		var currentBookmark = ajaxify.data.bookmark || storage.getItem(bookmarkKey);
		if (config.topicPostSort === 'newest_to_oldest') {
			index = Math.max(1, ajaxify.data.postcount - index + 2);
		}

		if (
			ajaxify.data.postcount > ajaxify.data.bookmarkThreshold &&
			(
				!currentBookmark ||
				parseInt(index, 10) > parseInt(currentBookmark, 10) ||
				ajaxify.data.postcount < parseInt(currentBookmark, 10)
			)
		) {
			if (app.user.uid) {
				socket.emit('topics.bookmark', {
					tid: ajaxify.data.tid,
					index: index,
				}, function (err) {
					if (err) {
						return app.alertError(err.message);
					}
					ajaxify.data.bookmark = index + 1;
				});
			} else {
				storage.setItem(bookmarkKey, index);
			}
		}

		// removes the bookmark alert when we get to / past the bookmark
		if (!currentBookmark || parseInt(index, 10) >= parseInt(currentBookmark, 10)) {
			app.removeAlert('bookmark');
		}
	}


	return Topic;
});
