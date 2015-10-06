Meteor.methods({
  base64Encode: function (unencoded) {
    return new Buffer(unencoded || '').toString('base64');
  },
  // Accept node inserts and updates from Drupal.
  DrupalSaveNode: function (data) {
    // Implementation of simple security.
    if (Meteor.settings.drupal_ddp.simple_security === true) {
      if (Meteor.settings.drupal_ddp.simple_security_token !== data.simple_security) {
        throw new Meteor.Error("Security token does not match!");
      }
    }

    if (Meteor.settings.drupal_ddp.debug_data === true) { console.log(data); }

    // Handle Nodes.
    if (data.content.ddp_type == 'node') {
      var actualColl = DrupalDdp.collections[data.content.type];
      if (!actualColl) {
        throw new Meteor.Error("You haven't registered this type of collection yet.");
      }

      // If content is flagged for deletion, remove.
      if (data.content.delete_content) {
        // Delete existing posts.
        actualColl.remove({nid: data.content.nid});
      }
      // Otherwise, insert/update.
      else {
        // Update existing posts.
        actualColl.upsert({nid: data.content.nid},{$set: data.content});
      }
    }

    // Handle Taxonomies.
    if (data.content.ddp_type == 'taxonomy') {
      var actualTax = DrupalDdp.taxonomies[data.content.vocabulary_machine_name];
      if (data.content.delete_content) {
        // Delete existing taxonomies.
        actualTax.remove({tid: data.content.tid});
      }
      else {
        actualTax.upsert({
          tid: data.content.tid
        },{
          $set: data.content
        });
      }
    }

    // Handle Users.
    if (data.content.ddp_type == 'user') {
      // Clean up data and prepare profile information
      cleanUpProfile = [
        'rdf_mapping',
        'original',
        'data',
        'name',
        'mail',
        'pass',
        'ddp_type'
      ];
      profileData = _.omit(data.content, cleanUpProfile);

      if (data.content.delete_content) {
        // Delete existing user.
        userId = Meteor.users.findOne({'profile.uid' : data.content.uid})._id;
        Meteor.users.remove(userId);
      }
      else if (!(Meteor.users.findOne({'profile.uid' : data.content.uid}))) {
        // Create User.
        Accounts.createUser({
          username: data.content.name,
          email : data.content.mail,
          password : data.content.pass,
          profile  : profileData
        });
      }
      else {
        Meteor.users.update(
          {'profile.uid' : data.content.uid},
          {$set:
            {
              'emails.0.address' : data.content.mail,
              'username' : data.content.name,
              'profile' : profileData
            },
          }
        );
      }
    }

    if (data.content.ddp_type === 'update_user_password') {
      var bcrypt = NpmModuleBcrypt;
      var bcryptHash = Meteor.wrapAsync(bcrypt.hash);
      var passwordHash = bcryptHash(data.content.sha_pass, 10);

      var userId = null;

      // In the event that the user doesn't exist yet
      // (very rare) AND the 'update_user_password' request
      // arrives, then create the user with basic info.
      if (!(Meteor.users.findOne({'profile.uid' : data.content.uid}))) {
        userId = Accounts.createUser({
          username: data.content.name,
          email : data.content.mail,
          password : data.content.sha_pass,
          profile: {
            uid : data.content.uid
          }
        });
      } else {
        userId = Meteor.users.findOne({
          'profile.uid': data.content.uid
        })._id;
      }

      // Set user password and 'verify' their account.
      Meteor.users.update({_id : userId}, {$set: {'services.password.bcrypt' : passwordHash}});
      Meteor.users.update({_id : userId}, {$set: {'emails.0.verified' : true}});
    }
  },
  getDrupalDdpToken: function(type) {
    if (type === 'read') {
      var options = {
        url: Meteor.settings.drupal_ddp.drupal_url + "/restws/session/token",
        username : Meteor.settings.drupal_ddp.restws_read_user,
        password : Meteor.settings.drupal_ddp.restws_read_pass,
      };
    } else {
      var options = {
        url: Meteor.settings.drupal_ddp.drupal_url + "/restws/session/token",
        username : Meteor.settings.drupal_ddp.restws_user,
        password : Meteor.settings.drupal_ddp.restws_pass,
      };
    }

    if (Meteor.settings.drupal_ddp.debug_data === true) {
      console.log('======== Connection Options ==========');
      console.log(options);
    }

    var auth = 'Basic ' + Meteor.call('base64Encode', options.username + ':' + options.password);

    try {
      var result = HTTP.post(options.url, {
        headers: {
          Authorization: auth
        }
      });

      tokenResponse = {
        token: result.content,
        cookie: result.headers['set-cookie'][0],
      };

      if (Meteor.settings.drupal_ddp.debug_data === true) {
        console.log('======== Connection Successful: Token ==========');
        console.log(tokenResponse);
      }

      return tokenResponse;
    } catch (e) {
      if (Meteor.settings.drupal_ddp.debug_data === true) {
        console.log('======== Error Creating Token ==========');
        console.log(e);
      } else {
        return false;
      }
    }
  },
  updateNodeInDrupal: function(node) {
    tokenCookie = Meteor.call('getDrupalDdpToken', 'write');

    if (Meteor.settings.drupal_ddp.debug_data === true) {
      console.log('======== Base URL and Endpoint ==========');
      console.log(Meteor.settings.drupal_ddp.drupal_url);
      console.log(Meteor.settings.drupal_ddp.drupal_url + '/node/' + node.nid);
    }

    if (Meteor.settings.drupal_ddp.debug_data === true) {
      console.log('======== Token (writing to Drupal) ==========');
      console.log(tokenCookie);
    }

    // These are items in a node that aren't supported for writing
    // via restws in Drupal.
    cleanUpNode = [
      'is_new',
      'vid',
      'ddp_type',
      'comment',
      'comments',
      'changed',
      'url',
      'edit_url',
      'comment_count',
      'comment_count_new',
      'revision',
      'language',
      'author',
      'field_tags',
      'field_image',
      'created',
      'status',
      'promote',
      'sticky',
    ];

    // Preparing the node to be sent back to Drupal.
    if (node.hasOwnProperty('content')) {
      node = node.content;
    } else {
      // Add '_id' to the list of fields to be removed from
      // the node.
      cleanUpNode.push('_id');
    }

    // Check for File fields and Taxonomy fields to
    // remove because restws can't handle the heat.
    _.each(node, function(value, key, obj){
      // If obj is array
      if (_.isArray(value) && !_.isNull(value) && !_.isEmpty(value)) {
        // If 'file' exists here, then it's a file_field,
        // add key cleanUpNode array.
        if (_.has(value[0], 'file')) {
          cleanUpNode.push(key);
        }

        // If 'tid' exists here, then it's a taxonomy term,
        // add key to cleanUpNode array.
        if (_.has(value[0], 'tid')) {
          cleanUpNode.push(key);
        }
      }
    });

    // Remove fields from node object that aren't supported
    // for writing back to drupal.
    node = _.omit(node, cleanUpNode);

    if (Meteor.settings.drupal_ddp.debug_data === true) {
      console.log('======== Content Going back to drupal ==========');
      console.log(node);
    }

    if (tokenCookie) {
      try {
        baseUrl = Meteor.settings.drupal_ddp.drupal_url;
        endpoint = baseUrl + '/node/' + node.nid;

        var requestHeaders = {
          'Content-type': 'application/json',
          'X-CSRF-Token': tokenCookie.token,
          'Accept': 'application/json',
          'Cookie': tokenCookie.cookie,
        };

        if (Meteor.settings.drupal_ddp.debug_data === true) {
          console.log('======== Request Headers ==========');
          console.log(requestHeaders);
        }

        var result = HTTP.put(
          endpoint,
          {
            headers: {
              'Content-type': 'application/json',
              'X-CSRF-Token': tokenCookie.token,
              'Accept': 'application/json',
              'Cookie': tokenCookie.cookie,
            },
            data: node
          }
        );
        return result;
      } catch (e) {
        if (Meteor.settings.drupal_ddp.debug_data === true) {
          console.log('====== START: Server Response ======');
          console.log(e);
          console.log('====== END: Server Response ======');
        }
        return e;
      }
    }
  },
});
