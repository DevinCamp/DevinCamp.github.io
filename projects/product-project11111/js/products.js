/* global $ _ */
$(function(){
$(document).ready(function () {
  // ALL YOUR CODE GOES BELOW HERE //
    $.getJSON('data/product.json', function (data) {
 console.log(data)
      
    }).fail(function(){console.log('noJSON');});
  
  
  
  // ALL YOUR CODE GOES ABOVE HERE //
    }); 
});