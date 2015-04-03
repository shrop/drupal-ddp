Meteor.methods({
  base64Encode: function (unencoded) {
    return new Buffer(unencoded || '').toString('base64');
  },
  // Accept node inserts and updates from Drupal.
  DrupalSaveNode: function (data) {
    if (Meteor.settings.drupal_ddp.debug_data == true) {
      console.log(data);
    }
    
    // Handle Nodes
    if(data.content.ddp_type == 'node'){
      var actualColl = DrupalDdp.collections[data.content.type];
      if (!actualColl) {
        throw new Meteor.Error("You haven't registered this type of collection yet.");
      }
      if (data.content.is_new) {
        // Add new posts.
        actualColl.insert(data);
      }
      else if(data.content.delete_content){
        // Delete existing posts.
        actualColl.remove({"content.nid": data.content.nid});
      }
      else {
        // Update existing posts.
        actualColl.upsert({"content.nid": data.content.nid},{$set: data.content});
      }
    }

    // Handle Taxonomies
    if(data.content.ddp_type == 'taxonomy'){
      if (data.content.is_new) {
        drupalDdpTaxonomies.insert(data);
      }
      else if(data.content.delete_content){
        // Delete existing taxonomies.
        drupalDdpTaxonomies.remove({"content.tid": data.content.tid});
      }
      else {
        // Update existing taxonomies.
        drupalDdpTaxonomies.update({"content.tid": data.content.tid},{$set:{content:data.content}});
      }
    }

    // Handle Users
    if(data.content.ddp_type == 'user'){
      if (data.content.is_new) {
        // Create User
        Accounts.createUser({
          username: data.content.name,
          email : data.content.mail,
          password : data.content.pass,
          profile  : {
            first_name: 'First',
            last_name: 'Last',
            uid: data.content.uid,
            roles: data.content.roles,
          }
        });

        // Set account 'verified' to true and set password to drupal password.
        Meteor.users.update({"profile.uid" : data.content.uid}, {$set: {"emails.0.verified" : true}});
        Meteor.users.update({"profile.uid" : data.content.uid}, {$set: {"services.password.bcrypt" : data.content.pass}});
      }
      else if(data.content.delete_content){
        // Delete existing user.
        user_id = Meteor.users.findOne({"profile.uid" : data.content.uid})._id;
        Meteor.users.remove(user_id);
      }
      else {
        // TODO
        // Update existing user.
        // update profile
        // update name & password
        // update username
        // update email
        // update roles
        // Meteor.users.update({"profile.uid" : data.content.uid});
      }
    }
  },
  getDrupalDdpToken: function() {
    var options = {
      url: Meteor.settings.drupal_ddp.ddp_url + "/restws/session/token",
      username : Meteor.settings.drupal_ddp.restws_user,
      password : Meteor.settings.drupal_ddp.restws_pass,
    };

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
      }

      return tokenResponse;
    } catch (e) {
      return false;
    }
  },
  updateNodeInDrupal: function(node) {
    tokenCookie = Meteor.call('getDrupalDdpToken');

    // Preparing the node to be sent back to Drupal.
    node = node.content;
    
    if (Meteor.settings.drupal_ddp.debug_data == true) {
      console.log('======== Content Going back to drupal ==========');
      console.log(node);
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
    ];

    // Check for File fields and remove.
    _.each(node, function(value, key, obj){
      // If obj is array
      if(_.isArray(value) && !_.isNull(value) && !_.isEmpty(value)) {
        // If 'file' exists here, then it's a file_field,
        // add key cleanUpNode array.
        if(_.has(value[0], 'file')) {
          cleanUpNode.push(key);
        }

        // If 'tid' exists here, then it's a taxonomy term,
        // add key to cleanUpNode array.
        if(_.has(value[0], 'tid')) {
          cleanUpNode.push(key);
        }
      }
    });

    // Remove fields from node object that aren't supported
    // for writing back to drupal.
    node = _.omit(node, cleanUpNode);

    if (tokenCookie) {
      try {
        baseUrl = Meteor.settings.drupal_ddp.ddp_url;
        endpoint = baseUrl + '/node/' + node.nid; 

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
        if (Meteor.settings.drupal_ddp.debug_data == true) {
          console.log('====== START: Server Response ======');
          console.log(e);
          console.log('====== END: Server Response ======');
        }
        return false;
      }
    }
  },
});